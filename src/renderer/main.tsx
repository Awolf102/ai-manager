import { createRoot } from 'react-dom/client'
import App from './App'
import '@fontsource-variable/inter/index.css'
import './tokens.css'
import './styles.css'
import '@xyflow/react/dist/style.css'
import '@xterm/xterm/css/xterm.css'

// Note: intentionally NOT wrapped in <StrictMode> — terminal panes hold
// imperative PTY/xterm side effects that StrictMode's double-mount would
// spawn twice in dev.
createRoot(document.getElementById('root')!).render(<App />)
