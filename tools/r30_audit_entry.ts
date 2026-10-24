/** R30 A 线几何自检入口（一次性；esbuild 打进 r29_probe_bundle.mjs 旁路） */
export {
  makeViaduct, makeParapet, makeLamps, makeGate, makeTowerGroup, makeInnerCity, makeMainHall,
  setDetailLevel
} from '../src/render/scene/castleKit';
export {
  flyingButtress, blindArcadeRow, traceryWindowX, traceryWindowZ, crocketRun,
  finialOrnament, statueNicheX, statueNicheZ, corniceBand, capitalCollar, balusterPost,
  corridorRun, corridorCrossing, corridorGallery
} from '../src/render/scene/castleDetail';
