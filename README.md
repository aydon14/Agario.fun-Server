## Readme Updated 7/1/25

This is a fork of Ardaninho's agario.fun server.

https://github.com/Ardaninho/ArdaninhoAgarServer/

This server is designed to work with my agar.io client. Both the client and server are designed to be portable, and can be ran locally on any machine.

# Single player Installation

1. Download the main code from GitHub.
2. Extract into separate folder.
3. Install node.js: 'https://nodejs.org/'
4. Install dependencies by running 'npm i' from a CMD window.
5. Paste any config file from './Saved Configs' into './src/' folder AND rename file to 'config.ini' (If not done, the server will build a plain config.ini automatically)
6. Run './src/Start.bat' from a CMD window.

# Multiplayer Installation

1. (Optional) If you are hosting a multiplayer server, then port forward your PC. Tutorials are found online.
2. If someone else is hosting, you can join as long as they port forward.
3. If your server connection fails, then you may have to change security settings in your browser. Instructions below:

Firefox:
1. Go to 'about:config' in the URL and search 'network.websocket.allowInsecureFromHTTPS' and set to True
2. Go to 'about:preferences#privacy' and disable 'Block dangerous and deceptive content'

Google Chrome/Chromium browsers:
1. In your browser, go to 'aydon14.github.io/agario-client', and click the lock icon in the URL, then click on 'Site settings'
2. Under 'Permissions', set 'Insecure content' to Allow

NOTES:

These settings allow insecure traffic (HTTP, like your server) over secure sites (HTTPS, like github.io).
DO NOT enable insecure traffic on other sites unless you understand the risk.