# Splash Arena

A Three.js water-blaster arena game featuring Squirtle, Charmander, Pikachu and Bulbasaur.
English menus, 12 stages, four upgrade branches, increasingly capable rivals,
original music and touch controls. v0.16.0.

## Run

Node.js 20+.

```sh
npm start
```

The included build is ready to serve. The server listens on PORT (default 3000).
To edit and rebuild:

```sh
npm install
npm run build
npm test
```

The root index.html is the entry point. All models, audio and Three.js modules
are bundled locally. No API key, backend or CDN is required. Use HTTP hosting;
do not open the web build through file://. Offline embedding is also available
with npm run build:offline.

## Eazo import

Upload the entire ZIP as an existing project. Suggested prompt:

> Import this existing Three.js game. Use root index.html as the entry point,
> npm run build to build, and npm start to preview on the platform PORT.
> Preserve the existing arena, animated Pokemon roster, stages, upgrades,
> music and mobile controls. Continue editing the supplied source.

The archive is validated locally. Import/publication inside your Eazo account
has not been performed.

## Controls

- Touch: left stick to move; hold Spray on the right to auto aim and spray.
- Keyboard: WASD / arrows to move, Space for auto aim and spray, Esc to pause.
- Mouse: aim and hold the left button to spray.
- Stop spraying to refill slowly. A glowing fountain refills faster.
- Complete the goal while staying on the platform. Clearing every rival ends
  the stage automatically. Boss stages require all boss rounds.

Progress saves to the browser and site address. Saves do not transfer
automatically between devices or hosting platforms.

## Source

- source/game_design_shell_v3.html: UI markup and controller.
- source/gameplay.js, campaign.js: physics, AI, stages and upgrades.
- renderer_v3.js, character-viewer-v3.js, water-flow.js: rendering and animation.
- touch-controls.js, player-controls.js: touch input and aiming.
- assets/pokemon/: four GLBs with embedded textures and skeletal animation.
- audio/, game-audio.js: music and effects.
- source/*test*: 17 automated suites, including actual model deformation,
  equipment sockets, mobile input, progression, AI and fixed arena projection.

## Credits

Pokemon models and animation: [06wj/pokemon](https://github.com/06wj/pokemon),
revision 00d96f7f18894055e7f1db44fa0df6462e5e4c8a.
The source's MIT software license does not grant rights to Pokemon assets.
This is an unofficial fan project, not affiliated with the rights holders.
See assets/ATTRIBUTION.txt and assets/POKEMON-SOURCE-LICENSE.txt.
Garden geometry, water effects, runtime props and music were authored for this project.
Three.js: MIT, see vendor/THREE-LICENSE.txt.
