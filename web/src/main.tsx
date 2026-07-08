import { render } from 'preact';
import '@fontsource-variable/literata';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles.css';
import { App } from './app.js';

render(<App />, document.getElementById('app')!);
