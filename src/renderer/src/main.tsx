import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/base.css'

const container = document.getElementById('root')
if (container === null) throw new Error('renderer root element is missing')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
