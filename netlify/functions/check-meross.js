const MerossCloud = require('meross-cloud');

exports.handler = async function (event, context) {
   const options = {
    email: process.env.MEROSS_EMAIL,
    password: process.env.MEROSS_PASSWORD,
    apiUrl: 'https://meross.com',
    logger: () => {}
  };


  return new Promise((resolve) => {
    const meross = new MerossCloud(options);

    meross.on('deviceInitialized', (deviceId, deviceDef, device) => {
      // Controlla se il dispositivo è la tua presa MSS305ZT
      if (deviceDef.deviceType && deviceDef.deviceType.toLowerCase().includes('mss305')) {
        device.getSystemAllData((err, res) => {
          if (err) {
            resolve({
              statusCode: 500,
              body: JSON.stringify({ errore: 'Errore lettura dati presa' })
            });
            return;
          }

          // Legge se l'interruttore è acceso (1 = ON, 0 = OFF)
          const onoff = res.all.digest.togglex ? res.all.digest.togglex[0].onoff : 0;

          // Legge il consumo istantaneo (Meross restituisce i milliwatt, quindi dividiamo per 1000)
          device.getControlElectricity((errElec, resElec) => {
            const watt = (!errElec && resElec && resElec.electricity)
              ? Math.round(resElec.electricity.power / 1000)
              : 0;

            // Consideriamo la presa "effettivamente collegata e in carica" se supera i 50W
            const inCarica = onoff === 1 && watt > 50;

            resolve({
              statusCode: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                modello: deviceDef.deviceType,
                accesa: onoff === 1,
                watt: watt,
                kw: Number((watt / 1000).toFixed(2)),
                inCarica: inCarica
              })
            });
          });
        });
      }
    });

    meross.on('error', (err) => {
      resolve({
        statusCode: 500,
        body: JSON.stringify({ errore: err.message })
      });
    });

    // Timeout di sicurezza dopo 8 secondi
    setTimeout(() => {
      resolve({
        statusCode: 504,
        body: JSON.stringify({ errore: 'Tempo scaduto connessione Meross' })
      });
    }, 8000);

    meross.connect((err) => {
      if (err) {
        resolve({
          statusCode: 401,
          body: JSON.stringify({ errore: 'Login Meross fallito' })
        });
      }
    });
  });
};
