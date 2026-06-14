import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Custom plugin to serve data directory
function dataServerPlugin() {
  return {
    name: 'data-server',
    configureServer(server) {
      server.middlewares.use('/data/', (req, res, next) => {
        const url = new URL(req.url, `http://${req.headers.host}`).pathname
        const filePath = path.resolve(__dirname, url.substring(1))
        
        if (fs.existsSync(filePath)) {
          const ext = path.extname(filePath).toLowerCase()
          const mimeTypes = {
            '.json': 'application/json',
            '.mp4': 'video/mp4',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.webp': 'image/webp',
          }
          res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream')
          res.setHeader('Cache-Control', 'max-age=3600')
          fs.createReadStream(filePath).pipe(res)
          return
        }
        next()
      })
    }
  }
}

export default defineConfig({
  plugins: [react(), dataServerPlugin()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001'
    }
  }
})
