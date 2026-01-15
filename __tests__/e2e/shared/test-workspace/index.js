// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')

const app = express()
const PORT = process.env.PORT || 3000

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`)
})
