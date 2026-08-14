import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsApp } from './SettingsApp'
import '../styles/base.css'
import '../styles/settings.css'

const container = document.getElementById('root')
if (container === null) throw new Error('settings root element is missing')

createRoot(container).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>
)
