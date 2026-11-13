const crypto = require('crypto');
const mqtt = require('mqtt');

const PRESA_UUID = '26030559847382513701c4e7ae28c239';
const DB_HOST = 'ricarica-condivisa-default-rtdb.europe-west1' + '.firebasedatabase.app';
const DB_URL = 'https://' + DB_HOST + '/ricarica_live.json';
const DEFAULT_MQTT = ['mqtt-eu-4', 'meross', 'com'].join('.');

function queryDeviceMqtt(userId, key, domain, uuid, namespace, method = 'GET', payload = {}) {
  return new Promise((resolve) => {
    const appId = crypto.createHash('md5').update('app' + Date.now() + Math.random()).digest('hex');
    const clientId = `app:${appId}`;
    const hashedPassword = crypto.createHash('md5').update(userId + key).digest('hex');
    const responseTopic = `/app/${userId}-${appId}/subscribe`;
    const requestTopic = `/appliance/${uuid}/subscribe`;
    const messageId = crypto.randomBytes(16).toString('hex');
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = crypto.createHash('md5').update(messageId + key + timestamp).digest('hex');

    const brokerUrl = `mqtts://${domain || DEFAULT_MQTT}:2001`;
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
            method,
            namespace,
            payloadVersion: 1,
            sign,
            timestamp
          },
          payload
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
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  try {
    const userid = (process.env.MEROSS_USERID || '').trim();
    const key = (process.env.MEROSS_KEY || '').trim();
    const domain = (process.env.MEROSS_DOMAIN || DEFAULT_MQTT).trim();

    if (!userid || !key) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ errore: 'Chiavi Meross mancanti' }) };
    }

    const qs = event.queryStringParameters || {};
    const fbRes = await fetch(DB_URL).then(r => r.json()).catch(() => null);
    let statoDb = (fbRes && typeof fbRes === 'object') ? fbRes : {
      stato: 'attesa',
      secondiAccumulati: 0,
      inizioSegmentoTs: null,
      kwhImmesso: 0
    };

    const now = Date.now();
    let comandoInviato = null;

    // 1. Comando manuale dall'app (?toggle=1 accendi, ?toggle=0 spegni)
    if (qs.toggle === '1' || qs.toggle === '0') {
      const targetOnoff = Number(qs.toggle);
      await queryDeviceMqtt(userid, key, domain, PRESA_UUID, 'Appliance.Control.ToggleX', 'SET', {
        togglex: { channel: 0, onoff: targetOnoff }
      });
      comandoInviato = targetOnoff;
      if (targetOnoff === 1) statoDb.accensioneProgrammataTs = null;
      if (targetOnoff === 0) statoDb.spegnimentoProgrammatoTs = null;
      await new Promise(r => setTimeout(r, 800));
    }
    // 2. Controllo spegnimento programmato (ha priorità se entrambi scaduti)
    else if (statoDb.spegnimentoProgrammatoTs && now >= statoDb.spegnimentoProgrammatoTs) {
      await queryDeviceMqtt(userid, key, domain, PRESA_UUID, 'Appliance.Control.ToggleX', 'SET', {
        togglex: { channel: 0, onoff: 0 }
      });
      comandoInviato = 0;
      statoDb.spegnimentoProgrammatoTs = null;
      await new Promise(r => setTimeout(r, 800));
    }
    // 3. Controllo accensione programmata
    else if (statoDb.accensioneProgrammataTs && now >= statoDb.accensioneProgrammataTs) {
      await queryDeviceMqtt(userid, key, domain, PRESA_UUID, 'Appliance.Control.ToggleX', 'SET', {
        togglex: { channel: 0, onoff: 1 }
      });
      comandoInviato = 1;
      statoDb.accensioneProgrammataTs = null;
      await new Promise(r => setTimeout(r, 800));
    }

    // 4. Legge lo stato aggiornato e la potenza reale
    const [sysData, elecData] = await Promise.all([
      queryDeviceMqtt(userid, key, domain, PRESA_UUID, 'Appliance.System.All', 'GET'),
      queryDeviceMqtt(userid, key, domain, PRESA_UUID, 'Appliance.Control.Electricity', 'GET')
    ]);

    if (!sysData) {
      return { statusCode: 504, headers: corsHeaders, body: JSON.stringify({ errore: 'Presa Ricarica AUTO non raggiungibile' }) };
    }

    let accesa = false;
    if (sysData.all && sysData.all.digest && sysData.all.digest.togglex) {
      const toggle = Array.isArray(sysData.all.digest.togglex)
        ? sysData.all.digest.togglex
        : sysData.all.digest.togglex;
      accesa = toggle && toggle.onoff === 1;
    }
    if (comandoInviato !== null) accesa = (comandoInviato === 1);

    const watt = (elecData && elecData.electricity && typeof elecData.electricity.power === 'number')
      ? Math.round(elecData.electricity.power / 1000)
      : 0;
    const kw = Number((watt / 1000).toFixed(2));
    const inCarica = accesa && watt > 50;
    const isReset = qs.reset === '1';

    if (isReset) {
      statoDb.stato = 'attesa';
      statoDb.secondiAccumulati = 0;
      statoDb.inizioSegmentoTs = null;
      statoDb.kwhImmesso = 0;
    } else if (inCarica) {
      if (statoDb.stato === 'in_corso' && statoDb.ultimoCheckTs) {
        const deltaSec = Math.max(0, Math.min(900, (now - statoDb.ultimoCheckTs) / 1000));
        const kwMedio = ((statoDb.kwAttuali || kw) + kw) / 2;
        statoDb.kwhImmesso = Number(((statoDb.kwhImmesso || 0) + (kwMedio * (deltaSec / 3600))).toFixed(3));
      } else if (statoDb.stato !== 'in_corso') {
        statoDb.stato = 'in_corso';
        statoDb.inizioSegmentoTs = now;
      }
    } else {
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
      headers: corsHeaders,
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
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ errore: err.message }) };
  }
};

