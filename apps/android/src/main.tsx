import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/source-sans-3';
import './styles.css';
import App from './App';
import { listenForErrors } from './errors/reporter';

listenForErrors();

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
