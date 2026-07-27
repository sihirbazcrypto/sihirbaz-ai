import { spawn } from 'node:child_process';
const INTERVAL_MS=Math.max(30_000,Number(process.env.RADAR_INTERVAL_MS||30_000));let stopping=false;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function runScan(){return new Promise(resolve=>{const child=spawn(process.execPath,['scripts/scan-market.mjs'],{cwd:process.cwd(),stdio:'inherit',env:process.env});child.on('exit',code=>resolve(code??1));child.on('error',e=>{console.error('Radar tarama başlatma hatası:',e);resolve(1)})})}
process.on('SIGINT',()=>stopping=true);process.on('SIGTERM',()=>stopping=true);
console.log(`Sihirbaz dönerli radar başladı. Her tur hedefi ${INTERVAL_MS/1000} saniye.`);
while(!stopping){const started=Date.now();const code=await runScan();const elapsed=Date.now()-started;if(code!==0)console.error(`Radar taraması hata koduyla bitti: ${code}`);const wait=Math.max(1000,INTERVAL_MS-elapsed);if(!stopping){console.log(`Tur ${(elapsed/1000).toFixed(1)} sn sürdü. Sonraki tur ${(wait/1000).toFixed(1)} sn sonra.`);await sleep(wait)}}
console.log('Radar döngüsü durduruldu.');
