const crypto = require('crypto');
const mqtt = require('mqtt');

const SECRET = '23x17ahWarFH6w29';
const BASE_URL = 'https://meross.com';

async function callMerossApi(endpoint, payload, token = '') {
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(8).toString('hex');
  const params = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sign = crypto
    .createHash('md5')
    .update(SECRET + timestamp + nonce + params)
    .digest('hex');

  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token ? `Basic ${token}` : 'Basic',
      'vender': 'Meross',
      'AppVersion': '3.22.4',
      'AppLanguage': 'IT',
      'User-Agent': 'MerossIOT/3.22.4'
    },
    body: JSON.stringify({ params, sign, timestamp, nonce })
  });

  return response.json();
}

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
    const email = (process.env.MEROSS_EMAIL || '').trim();
    const password = (process.env.MEROSS_PASSWORD || '').trim();

    const loginRes = await callMerossApi('/v1/Auth/signIn', { email, password });
    if (loginRes.apiStatus !== 0 || !loginRes.data) {
      return { statusCode: 401, body: JSON.stringify({ errore: 'Login fallito' }) };
    }

    const { token, userid, key, mqttDomain } = loginRes.data;
    const devRes = await callMerossApi('/v1/Device/devList', {}, token);
    const devices = Array.isArray(devRes.data) ? devRes.data : [];
    const presa = devices.find(d => d.devName && d.devName.toLowerCase().includes('ricarica auto'));

    if (!presa) {
      return { statusCode: 404, body: JSON.stringify({ errore: 'Presa Ricarica AUTO non trovata' }) };
    }

    const domain = presa.domain || mqttDomain || '://meross.com';

    const [sysData, elecData] = await Promise.all([
      queryDeviceMqtt(userid, key, domain, presa.uuid, 'Appliance.System.All'),
      queryDeviceMqtt(userid, key, domain, presa.uuid, 'Appliance.Control.Electricity')
    ]);

    let accesa = false;
    if (sysData && sysData.all && sysData.all.digest && sysData.all.digest.togglex) {
      const toggle = Array.isArray(sysData.all.digest.togglex)
        ? sysData.all.digest.togglex[0]
        : sysData.all.digest.togglex;
      accesa = toggle.onoff === 1;
    }

    const watt = (elecData && elecData.electricity && typeof elecData.electricity.power === 'number')
      ? Math.round(elecData.electricity.power / 1000)
      : 0;

    const inCarica = presa.onlineStatus === 1 && accesa && watt > 50;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nome: presa.devName,
        online: presa.onlineStatus === 1,
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
