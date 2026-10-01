import React from 'react';
import { createRoot } from 'react-dom/client';
import Whiteboard from './Whiteboard';
import './whiteboard.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><Whiteboard /></React.StrictMode>,
);
