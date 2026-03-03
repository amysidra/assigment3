import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { notesRouter } from './modules/notes/router'

const app = new Hono()
  .route("/api/notes", notesRouter)

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

serve({
  fetch: app.fetch,
  port: 8000
}, (info) => {
  console.log(`Server is running on http://localhost:${info.port}`)
})
