const crypto = require('crypto');
const mqtt = require('mqtt');

const PRESA_UUID = '26030559847382513701c4e7ae28c239';
const DB_HOST = 'ricarica-condivisa-default-rtdb.europe-west1' + '.firebasedatabase.app';
const DB_URL = 'https://' + DB_HOST + '/ricarica_live.json';

function queryDeviceMqtt(userId, key, domain, uuid, namespace) {
  return new Promise((resolve) => {
    const appId = crypto.createHash('md5').update('app' + Date.now() + Math.random()).digest('hex');
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
    }, 5500);

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

exports.handler = async function (event) {
  try {
    const userid = (process.env.MEROSS_USERID || '').trim();
    const key = (process.env.MEROSS_KEY || '').trim();
    const domain = (process.env.MEROSS_DOMAIN || '://meross.com').trim();

    if (!userid || !key) {
      return { statusCode: 400, body: JSON.stringify({ errore: 'Chiavi Meross mancanti su Netlify' }) };
    }

    // Interroga in parallelo: stato interruttore, potenza istantanea, contatore energetico e Firebase
    const [sysData, elecData, consData, fbRes] = await Promise.all([
      queryDeviceMqtt(userid, key, domain, PRESA_UUID, 'Appliance.System.All'),
      queryDeviceMqtt(userid, key, domain, PRESA_UUID, 'Appliance.Control.Electricity'),
      queryDeviceMqtt(userid, key, domain, PRESA_UUID, 'Appliance.Control.ConsumptionX'),
      fetch(DB_URL).then(r => r.json()).catch(() => null)
    ]);

    if (!sysData) {
      return { statusCode: 504, body: JSON.stringify({ errore: 'Presa Ricarica AUTO non raggiungibile' }) };
    }

    let accesa = false;
    if (sysData.all && sysData.all.digest && sysData.all.digest.togglex) {
      const toggle = Array.isArray(sysData.all.digest.togglex)
        ? sysData.all.digest.togglex
        : sysData.all.digest.togglex;
      accesa = toggle && toggle.onoff === 1;
    }

    const watt = (elecData && elecData.electricity && typeof elecData.electricity.power === 'number')
      ? Math.round(elecData.electricity.power / 1000)
      : 0;
    const kw = Number((watt / 1000).toFixed(2));
    const inCarica = accesa && watt > 50;

    // Somma i Wh degli ultimi giorni registrati dal chip interno della presa (indice progressivo immune alla mezzanotte)
    let whContatorePresa = 0;
    if (consData && Array.isArray(consData.consumptionx)) {
      const ultimiGiorni = consData.consumptionx.slice(-5);
      whContatorePresa = ultimiGiorni.reduce((acc, item) => acc + (Number(item.value) || 0), 0);
    }

    const now = Date.now();
    const isReset = event.queryStringParameters && event.queryStringParameters.reset === '1';

    let statoDb = fbRes || {
      stato: 'attesa', // 'attesa' | 'in_corso' | 'pausa'
      secondiAccumulati: 0,
      inizioSegmentoTs: null,
      whBase: whContatorePresa,
      kwhImmesso: 0,
      inKm: 0,
      inPerc: 0,
      targetP: 80,
      targetK: 300,
      mode: 'p'
    };

    if (isReset) {
      // Azzera contatori e fissa il livello attuale del chip della presa come nuovo punto zero
      statoDb.stato = 'attesa';
      statoDb.secondiAccumulati = 0;
      statoDb.inizioSegmentoTs = null;
      statoDb.whBase = whContatorePresa;
      statoDb.kwhImmesso = 0;
    } else if (inCarica) {
      if (statoDb.stato !== 'in_corso') {
        // Avvio o ripresa dopo una pausa
        if (statoDb.stato === 'attesa') {
          statoDb.whBase = whContatorePresa;
          statoDb.secondiAccumulati = 0;
          statoDb.kwhImmesso = 0;
        } else if (statoDb.stato === 'pausa') {
          // Riallinea il riferimento energetico conservando i kWh già accumulati prima della pausa
          statoDb.whBase = whContatorePresa - Math.round((statoDb.kwhImmesso || 0) * 1000);
        }
        statoDb.stato = 'in_corso';
        statoDb.inizioSegmentoTs = now;
      }

      // Aggiorna i kWh reali dal contatore hardware
      if (whContatorePresa >= (statoDb.whBase || 0)) {
        statoDb.kwhImmesso = Number(((whContatorePresa - statoDb.whBase) / 1000).toFixed(2));
      }
    } else {
      // Presa spenta o sotto i 50W
      if (statoDb.stato === 'in_corso') {
        if (statoDb.inizioSegmentoTs) {
          statoDb.secondiAccumulati = (statoDb.secondiAccumulati || 0) + Math.max(0, (now - statoDb.inizioSegmentoTs) / 1000);
        }
        statoDb.inizioSegmentoTs = null;
        statoDb.stato = 'pausa';
      }
    }

    statoDb.wattAttuali = watt;
    statoDb.kwAttuali = kw;
    statoDb.presaAccesa = accesa;
    statoDb.ultimoCheckTs = now;

    await fetch(DB_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(statoDb)
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nome: 'Ricarica AUTO',
        accesa,
        watt,
        kw,
        inCarica,
        statoDb
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ errore: err.message }) };
  }
};
