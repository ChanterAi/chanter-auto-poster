'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const root = path.resolve(__dirname, '..', 'music-library');
const durationSeconds = 16;
const tracks = [
  {
    file: 'anime-epic/anime-epic-demo-01.mp3',
    expression: '0.12*sin(2*PI*110*t)+0.07*sin(2*PI*220*t)+0.05*sin(2*PI*329.63*t)+0.035*sin(2*PI*440*t)'
  },
  {
    file: 'cyberpunk-dark/cyberpunk-dark-demo-01.mp3',
    expression: '(0.16*sin(2*PI*55*t)+0.06*sin(2*PI*82.41*t))*(0.55+0.45*sin(2*PI*1.8*t))+0.035*sin(2*PI*440*t)'
  },
  {
    file: 'motivation-calm/motivation-calm-demo-01.mp3',
    expression: '0.08*sin(2*PI*130.81*t)+0.055*sin(2*PI*196*t)+0.04*sin(2*PI*261.63*t)'
  },
  {
    file: 'emotional-orchestral/emotional-orchestral-demo-01.mp3',
    expression: '0.09*sin(2*PI*98*t)+0.065*sin(2*PI*146.83*t)+0.045*sin(2*PI*196*t)+0.03*sin(2*PI*293.66*t)'
  },
  {
    file: 'aggressive-trap/aggressive-trap-demo-01.mp3',
    expression: '(0.22*sin(2*PI*48.99*t)+0.08*sin(2*PI*97.99*t))*abs(sin(2*PI*2.56*t))+0.045*sin(2*PI*392*t)*abs(sin(2*PI*5.12*t))'
  }
];

for (const track of tracks) {
  const outputPath = path.join(root, track.file);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const result = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', `aevalsrc=${track.expression}:s=44100:d=${durationSeconds}`,
    '-af', 'aecho=0.8:0.72:55:0.18,alimiter=limit=0.9',
    '-c:a', 'libmp3lame', '-b:a', '128k',
    '-y', outputPath
  ], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`Generated ${tracks.length} original demo tracks in ${root}`);
