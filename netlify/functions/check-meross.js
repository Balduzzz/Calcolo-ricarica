const crypto = require('crypto');

const SECRET = '23x17ahWarFH6w29';
const BASE_URL = 'https://iotx-eu.meross.com';

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
    body: JSON.stringify({
      params,
      sign,
      timestamp,
      nonce
    })
  });

  return response.json();
}

exports.handler = async function () {
  try {
    const email = (process.env.MEROSS_EMAIL || '').trim();
    const password = (process.env.MEROSS_PASSWORD || '').trim();

    if (!email || !password) {
      return {
        statusCode: 400,
        body: JSON.stringify({ errore: 'Credenziali mancanti su Netlify' })
      };
    }

    // 1. Login diretto sul server europeo Meross
    const loginRes = await callMerossApi('/v1/Auth/signIn', {
      email: email,
      password: password
    });

    if (loginRes.apiStatus !== 0 || !loginRes.data || !loginRes.data.token) {
      return {
        statusCode: 401,
        body: JSON.stringify({
          errore: 'Risposta Meross: ' + (loginRes.info || JSON.stringify(loginRes))
        })
      };
    }

    const token = loginRes.data.token;

    // 2. Recupera la lista dei dispositivi per trovare la presa MSS305ZT
    const devRes = await callMerossApi('/v1/Device/devList', {}, token);
    const devices = (devRes.data && Array.isArray(devRes.data)) ? devRes.data : [];
    const presa = devices.find(d => d.deviceType && d.deviceType.toLowerCase().includes('mss305')) || devices[0];

    if (!presa) {
      return {
        statusCode: 404,
        body: JSON.stringify({ errore: 'Nessuna presa Meross trovata sull account' })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nome: presa.devName,
        modello: presa.deviceType,
        online: presa.onlineStatus === 1,
        uuid: presa.uuid
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ errore: 'Errore tecnico: ' + err.message })
    };
  }
};
