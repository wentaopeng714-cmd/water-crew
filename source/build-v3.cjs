'use strict';

// Run from any working directory. All inputs are relative to this package.
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

function embeddedGLB(relative) {
  const data = fs.readFileSync(path.join(root, relative));
  if (data.toString('ascii', 0, 4) !== 'glTF' || data.readUInt32LE(4) !== 2) {
    throw new Error(`Expected a GLB v2 file: ${relative}`);
  }
  return `data:model/gltf-binary;base64,${data.toString('base64')}`;
}

async function build() {
  const source = read('source/game_design_shell_v3.html');
  if (source.split('/* CORE_MODULE */').length !== 2) throw new Error('Expected exactly one CORE_MODULE marker.');
  if ((source.match(/<script type="module"[^>]*>/g) || []).length !== 1) throw new Error('Expected one UI module script.');
  const web = process.argv.includes('--web');
  const modelURL = relative => web ? relative : embeddedGLB(relative);
  const embedded = '<script>window.WATER_CHARACTER_URL=' + JSON.stringify(modelURL('assets/character-v3.glb')) +
    ';window.WATER_ENVIRONMENT_URL=' + JSON.stringify(modelURL('assets/environment-v3.glb')) + ';</script>\n';

  // Bundle the current source modules directly (v0.4 effects retain v3 geometry filenames). No old bundle is used as input.
  await esbuild.build({
    stdin: {
      contents: "import {WaterRenderer} from './renderer_v3.js'; import {CharacterViewer} from './character-viewer-v3.js'; import {GameAudio} from './game-audio.js'; import {resolveAim} from './player-controls.js'; import {Campaign} from './campaign.js'; window.Campaign=Campaign; window.WaterRenderer=WaterRenderer; window.CharacterViewer=CharacterViewer; window.GameAudio=GameAudio; window.resolveAim=resolveAim;",
      resolveDir: root,
      sourcefile: 'visual-entry-v3.js'
    },
    outfile: path.join(root, 'game-visuals-v3.js'),
    bundle: true,
    format: 'iife',
    target: ['es2020'],
    minify: true,
    legalComments: 'eof',
    logLevel: 'info'
  });

  let html = source.replace('/* CORE_MODULE */', () => read('source/gameplay.js'));
  html = html.replace(/<script type="module"[^>]*>/, () => embedded + '<script src="game-visuals-v3.js?v=0.14.0"></script>\n<script>');
  for (const module of ['renderer_v3', 'character-viewer-v3', 'game-audio', 'player-controls', 'campaign']) {
    const pattern = new RegExp(`^import\\s+\\{[^}]+\\}\\s+from\\s+['"]\\./${module}\\.js['"];?\\s*$`, 'm');
    if (!pattern.test(html)) throw new Error(`UI import not found: ${module}.js`);
    html = html.replace(pattern, '');
  }
  if (html.includes('/* CORE_MODULE */') || /<script type="module"/.test(html)) throw new Error('Offline HTML conversion was incomplete.');
  fs.writeFileSync(path.join(root, 'index.html'), html);
  console.log('Built v0.14: index.html + game-visuals-v3.js; GLB assets ' + (web ? 'served as relative files.' : 'embedded.'));
}

build().catch(error => { console.error(error); process.exitCode = 1; });
