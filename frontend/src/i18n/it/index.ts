import admin from './admin'
import auth from './auth'
import common from './common'
import files from './files'
import mods from './mods'
import plugins from './plugins'
import servers from './servers'
import world from './world'

/** Dizionario italiano: chiave = testo inglese usato nel codice. */
export default { ...common, ...auth, ...servers, ...admin, ...mods, ...plugins, ...files, ...world }
