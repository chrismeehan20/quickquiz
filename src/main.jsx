import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import QuickQuiz from './QuickQuiz.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QuickQuiz />
  </StrictMode>,
)
