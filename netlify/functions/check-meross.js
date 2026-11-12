const crypto = require('crypto');
const mqtt = require('mqtt');

const PRESA_UUID = '26030559847382513701c4e7ae28c239';

function queryDeviceMqtt(userId, key, domain, uuid, namespace) {
  return new Promise((resolve) => {
    const appId = crypto.createHash('md5').update('app' + Date.now()).digest('hex');
    const clientId = `app:${appId}`;
    const hashedPassword = crypto.createHash('md5').update(userId + key).digest('hex');
    const responseTopic = `/app/${userId}-${appId}/subscribe`;
    const requestTopic = `/appliance/${uuid}/subscribe`;
    const messageId = crypto.randomBytes(16).toString('hex');
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = crypto.createHash('md5').update(messageId + key + timestamp).digest('hex');

    const brokerUrl = `mqtts://${domain || '://meross.com'}:2001`;
    const client = mqtt.connect(brokerUrl, {
      clientId,
      username: userId,
      password: hashedPassword,
      rejectUnauthorized: false
    });

    const timeout = setTimeout(() => {
      client.end(true);
      resolve(null);
    }, 5000);

    client.on('connect', () => {
      client.subscribe(responseTopic, () => {
        const msg = {
          header: {
            from: responseTopic,
            messageId,
            method: 'GET',
            namespace,
            payloadVersion: 1,
            sign,
            timestamp
          },
          payload: {}
        };
        client.publish(requestTopic, JSON.stringify(msg));
      });
    });

    client.on('message', (topic, message) => {
      try {
        const data = JSON.parse(message.toString());
        if (data.header && data.header.messageId === messageId) {
          clearTimeout(timeout);
          client.end(true);
          resolve(data.payload);
        }
      } catch (e) {}
    });

    client.on('error', () => {
      clearTimeout(timeout);
      client.end(true);
      resolve(null);
    });
  });
}

exports.handler = async function () {
  try {
    const userid = (process.env.MEROSS_USERID || '').trim();
    const key = (process.env.MEROSS_KEY || '').trim();
    const domain = (process.env.MEROSS_DOMAIN || '://meross.com').trim();

    if (!userid || !key) {
      return {
        statusCode: 400,
        body: JSON.stringify({ errore: 'Variabili MEROSS_USERID o MEROSS_KEY mancanti su Netlify' })
      };
    }

    const [sysData, elecData] = await Promise.all([
      queryDeviceMqtt(userid, key, domain, PRESA_UUID, 'Appliance.System.All'),
      queryDeviceMqtt(userid, key, domain, PRESA_UUID, 'Appliance.Control.Electricity')
    ]);

    if (!sysData) {
      return {
        statusCode: 504,
        body: JSON.stringify({ errore: 'Presa Ricarica AUTO offline o non raggiungibile' })
      };
    }

    let accesa = false;
    if (sysData.all && sysData.all.digest && sysData.all.digest.togglex) {
      const toggle = Array.isArray(sysData.all.digest.togglex)
        ? sysData.all.digest.togglex[0]
        : sysData.all.digest.togglex;
      accesa = toggle && toggle.onoff === 1;
    }

    const watt = (elecData && elecData.electricity && typeof elecData.electricity.power === 'number')
      ? Math.round(elecData.electricity.power / 1000)
      : 0;

    // In carica REALMENTE solo se accesa e sta erogando più di 50W
    const inCarica = accesa && watt > 50;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nome: 'Ricarica AUTO',
        accesa: accesa,
        watt: watt,
        kw: Number((watt / 1000).toFixed(2)),
        inCarica: inCarica
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ errore: 'Errore tecnico: ' + err.message })
    };
  }
};
