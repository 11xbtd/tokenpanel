import { startPreload, type StartupHost, type StartupTarget } from './startup'

const target = window as unknown as StartupTarget & { utools?: StartupHost }
const host = target.utools ?? (globalThis as unknown as { utools?: StartupHost }).utools
startPreload(target, () => require('./preload-core.js'), host)
