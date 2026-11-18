import type { FastifyInstance } from 'fastify'
import { findServer } from '../registry.js'

/**
 * Mod, Workshop e modpack esistono solo per i server tModLoader: su un server vanilla o TShock le rotte
 * con :id rispondono 409 (le mod restano su disco e tornano disponibili passando a tModLoader).
 */
export function modsOnlyForTmodloader(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    const id = (req.params as { id?: unknown } | undefined)?.id
    if (typeof id !== 'string') return
    const server = await findServer(id)
    if (server && server.game !== 'tmodloader') {
      return reply.code(409).send({
        error: 'conflict',
        message: `${server.name} è un server ${server.game === 'tshock' ? 'TShock' : 'Terraria vanilla'}: passa a tModLoader per usare le mod`,
      })
    }
  })
}
