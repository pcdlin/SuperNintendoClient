// noinspection JSBitwiseOperatorUsage

// Archipelago server
const DEFAULT_SERVER_PORT = 38281;
let serverSocket = null;
let lastServerAddress = null;
let serverPassword = null;
let serverAuthError = false;

// Players in the current game, received from Connected server packet
let playerSlot = null;
let playerTeam = null;
let players = [];
let hintCost = null;

// Track reconnection attempts.
const maxReconnectAttempts = 10;
let preventReconnect = false;
let reconnectAttempts = 0;
let reconnectTimeout = null;

// Control variable for the SNES watcher. Contains an interval (see MDN: setInterval)
let snesInterval = null;
let snesIntervalComplete = true;
let lastBounce = 0;

// DeathLink Control
const DEATH_LINK_ALIVE = 0;
const DEATH_LINK_KILLING = 1;
const DEATH_LINK_DEAD = 2;
let deathLinkState = DEATH_LINK_ALIVE;
let lastDeathLink = new Date().getTime();
const DEATH_LINK_COOLDOWN = 3000; // Milliseconds

const CLIENT_STATUS = {
  CLIENT_UNKNOWN: 0,
  CLIENT_READY: 10,
  CLIENT_PLAYING: 20,
  CLIENT_GOAL: 30,
};

/**
 * Returns a randomly chosen DeathLink message
 * @param playerName
 * @returns {string}
 */
const getRandomDeathLinkMessage = (playerName) => {
  const deathLinkMessages = [
    `${playerName} has died, and took you with them.`,
    `${playerName} has met with a terrible fate, and they felt like sharing.`,
    `${playerName} dug a grave big enough for everyone to share.`,
    `Oh look, everyone died! Blame ${playerName}.`,
    `Don't worry ${playerName}, nobody saw that. Because they're dead too.`,
    `Have you ever heard the tragedy of Darth ${playerName} the wise?`,
    `Death comes for us all. Because ${playerName} invited him.`,
    `Death-warps aren't an option right now, ${playerName}...`,
    `${playerName} used DeathLink! It's super-effective!`,
    `Run for your lives! ${playerName} is killing people!`,
    `Is ${playerName} throwing for content?`,
    `${playerName} took an arrow to the knee. Now, their adventuring days are over.`,
    `${playerName} has won a free trip to the title screen, and they invited some friends!`,
    `All ${playerName}'s base are belong to us.`,
    `It's dangerous to go alone, ${playerName}. Take everyone with you.`,
  ];

  return deathLinkMessages[Math.floor(Math.random() * (deathLinkMessages.length))];
};

window.addEventListener('load', async () => {
  const game = await window.dataExchange.getGame();
  if (game) {
    const gameInstanceScript = document.createElement('script');
    gameInstanceScript.setAttribute('type', 'application/ecmascript');
    gameInstanceScript.setAttribute('src', `games/${game}/romData.js`);
    document.head.appendChild(gameInstanceScript);

    const romDataScript = document.createElement('script');
    romDataScript.setAttribute('type', 'application/ecmascript');
    romDataScript.setAttribute('src', `games/${game}/${game}.js`);
    document.head.appendChild(romDataScript);
  }

  // Handle server address change
  document.getElementById('server-address').addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') { return; }

    // If the input value is empty, do not attempt to reconnect
    if (!event.target.value) {
      preventReconnect = true;
      lastServerAddress = null;

      // If the socket is open, close it
      if (serverSocket && serverSocket.readyState === WebSocket.OPEN) {
        serverSocket.close();
        serverSocket = null;
      }

      // If the user did not specify a server address, do not attempt to connect
      return;
    }

    // User specified a server. Attempt to connect
    preventReconnect = false;
    connectToServer(event.target.value);
  });
});

const connectToServer = (address, password = null) => {
  if (serverSocket && serverSocket.readyState === WebSocket.OPEN) {
    serverSocket.close();
    serverSocket = null;
  }

  // If an empty string is passed as the address, do not attempt to connect
  if (!address) { return; }

  // If the client has not loaded any game logic at this point, prevent connecting to the AP server
  if (!gameLogicLoaded) {
    appendConsoleMessage("No game logic has been loaded. Unable to connect to AP server.");
    return;
  }

  // This is a new connection attempt, no auth error has occurred yet
  serverAuthError = false;

  // If there are no SNES devices available, do nothing
  if (snesDevice === null) { return; }

  // Determine the server address
  let serverAddress = address;
  if (serverAddress.search(/^\/connect /) > -1) { serverAddress = serverAddress.substring(9); }
  if (serverAddress.search(/:\d+$/) === -1) { serverAddress = `${serverAddress}:${DEFAULT_SERVER_PORT}`;}

  // Store the password, if given
  serverPassword = password;

  // Attempt to connect to the server
  serverSocket = new WebSocket(`ws://${serverAddress}`);
  serverSocket.onopen = (event) => {
    // If a new server connection is established, that server will inform the client which items have been sent to
    // the ROM so far, if any. Clear the client's current list of received items to prevent the old list from
    // contaminating the new one, sometimes called "seed bleed".
    gameInstance = new GameInstance();
  };

  // Handle incoming messages
  serverSocket.onmessage = async (event) => {
    const commands = JSON.parse(event.data);
    for (let command of commands) {
      const serverStatus = document.getElementById('server-status');
      switch(command.cmd) {
        case 'RoomInfo':
          // Update sidebar with info from the server
          document.getElementById('server-version').innerText =
            `${command.version.major}.${command.version.minor}.${command.version.build}`;
          document.getElementById('forfeit-mode').innerText = permissionMap[command.permissions.forfeit];
          document.getElementById('remaining-mode').innerText = permissionMap[command.permissions.remaining];
          hintCost = Number(command.hint_cost);
          document.getElementById('points-per-check').innerText = command.location_check_points.toString();

          // Update the local data package cache if necessary
          if (!localStorage.getItem('dataPackageVersion') || !localStorage.getItem('dataPackage') ||
            command.datapackage_version !== localStorage.getItem('dataPackageVersion')) {
            requestDataPackage();
          } else {
            // Load the location and item maps into memory
            buildItemAndLocationData(JSON.parse(localStorage.getItem('dataPackage')));
          }

          // Connect to the AP server
          await gameInstance.authenticate();

          // Run game-specific handler
          await gameInstance.RoomInfo(command);
          break;

        case 'Connected':
          // Save the last server that was successfully connected to
          lastServerAddress = address;

          // Reset reconnection info if necessary
          reconnectAttempts = 0;

          // Set the hint cost text
          document.getElementById('hint-cost').innerText =
            (Math.round((hintCost / 100) *
              (command.checked_locations.length + command.missing_locations.length))).toString();

          // Update header text
          serverStatus.classList.remove('disconnected');
          serverStatus.innerText = 'Connected';
          serverStatus.classList.add('connected');

          // Save the list of players provided by the server
          players = command.players;

          // Save information about the current player
          playerTeam = command.team;
          playerSlot = command.slot;

          // Run game-specific handler
          await gameInstance.Connected(command);

          snesInterval = setInterval(async () => {
            // DO not run multiple simultaneous scan loops
            if (!snesIntervalComplete) { return; }

            // SNES Interval is now running, do not run another one
            snesIntervalComplete = false;

            // Send a bounce packet once every five minutes or so
            const currentTime = new Date().getTime();
            if (currentTime > (lastBounce + 300000)){
              if (serverSocket && serverSocket.readyState === WebSocket.OPEN) {
                lastBounce = currentTime;
                serverSocket.send(JSON.stringify([{
                  cmd: 'Bounce',
                  slots: [playerSlot],
                  data: currentTime,
                }]));
              }
            }

            // DeathLink Logic
            if (await gameInstance.isDeathLinkEnabled()) {
              // Determine if the player is currently dead
              const playerIsDead = await gameInstance.isPlayerDead();

              // If the player is currently dead and the DeathLink state has not yet been updated to reflect that,
              // send a DeathLink signal to the server
              if (playerIsDead) {
                if (
                  (deathLinkState === DEATH_LINK_ALIVE) && // Player was last known to be alive
                  ((lastDeathLink + DEATH_LINK_COOLDOWN) < new Date().getTime()) // Cooldown has passed
                ) {
                  // Send the DeathLink message
                  if (serverSocket && serverSocket.readyState === WebSocket.OPEN) {
                    // Set the state to DEAD before sending the message
                    deathLinkState = DEATH_LINK_DEAD;

                    // Send the DeathLink signal
                    lastDeathLink = new Date().getTime();
                    serverSocket.send(JSON.stringify([{
                      cmd: 'Bounce',
                      tags: ['DeathLink'],
                      data: {
                        time: (lastDeathLink / 1000),
                        source: players.find((player) =>
                          (player.team === playerTeam) && (player.slot === playerSlot)).alias,
                        cause: getRandomDeathLinkMessage(players.find((player) =>
                          (player.team === playerTeam) && (player.slot === playerSlot)).alias),
                      }
                    }]));
                    appendConsoleMessage(getRandomDeathLinkMessage(players.find((player) =>
                      (player.team === playerTeam) && (player.slot === playerSlot)).alias));
                  }
                }

                // If the player is dead, the DeathLink state must reflect that
                deathLinkState = DEATH_LINK_DEAD;
              }

              if (!playerIsDead) {
                switch (deathLinkState) {
                  case DEATH_LINK_ALIVE:
                    // Do nothing, this is fine
                    break;

                  case DEATH_LINK_KILLING:
                    // Keep sending the kill signal if the player is supposed to be dead. This prevents bugs where
                    // sometimes players will end up with zero health, but still be alive
                    await gameInstance.killPlayer();
                    break;

                  case DEATH_LINK_DEAD:
                    // If the player is alive, DeathLink signals may be sent again
                    deathLinkState = DEATH_LINK_ALIVE;
                    break;
                }
              }
            }

            // Run the client logic loop
            gameInstance.runClientLogic().then(() => {
              snesIntervalComplete = true;
            }).catch(async (err) => {
              await window.logging.writeToLog(err.message);

              appendConsoleMessage('There was a problem communicating with your SNES device. Please ensure it ' +
                'is powered on, the ROM is loaded, and it is connected to your computer.');

              // Disconnect from the AP server
              if (serverSocket && serverSocket.readyState === WebSocket.OPEN) {
                serverSocket.close();
              }

              snesDevice = null;
              setTimeout(initializeSNIConnection, 5000);
              clearInterval(snesInterval);
              snesIntervalComplete = true;
            });
          });
          break;

        case 'ConnectionRefused':
          serverStatus.classList.remove('connected');
          serverStatus.innerText = 'Not Connected';
          serverStatus.classList.add('disconnected');
          if (serverSocket && serverSocket.readyState === WebSocket.OPEN) {
            if (command.errors.includes('InvalidPassword')) {
              appendConsoleMessage(serverPassword === null ?
                'A password is required to connect to the server. Please use /connect [server] [password]' :
                'The password you provided was rejected by the server.'
              );
            } else {
              appendConsoleMessage(`Error while connecting to AP server: ${command.errors.join(', ')}.`);
            }
            serverAuthError = true;
            serverSocket.close();
            serverSocket = null;

            // Run game-specific handler
            await gameInstance.ConnectionRefused(command);
          }
          break;

        case 'ReceivedItems':
          await gameInstance.ReceivedItems(command);
          break;

        case 'LocationInfo':
          // Run game-specific handler
          await gameInstance.LocationInfo(command);
          break;

        case 'RoomUpdate':
          // Update sidebar with info from the server
          if (command.hasOwnProperty('version')) {
            document.getElementById('server-version').innerText =
              `${command.version.major}.${command.version.minor}.${command.version.build}`;
          }

          if (command.hasOwnProperty('forfeit_mode')) {
            document.getElementById('forfeit-mode').innerText =
              command.forfeit_mode[0].toUpperCase() + command.forfeit_mode.substring(1).toLowerCase();
          }

          if (command.hasOwnProperty('remaining_mode')) {
            document.getElementById('remaining-mode').innerText =
              command.remaining_mode[0].toUpperCase() + command.remaining_mode.substring(1).toLowerCase();
          }

          if (command.hasOwnProperty('hint_cost')) {
            hintCost = Number(command.hint_cost);
            const dataPackage = JSON.parse(localStorage.getItem('dataPackage'));
            document.getElementById('hint-cost').innerText =
              (Math.floor((hintCost / 100) * Object.keys(dataPackage.games[gameInstance.gameName]).length)).toString();
          }

          if (command.hasOwnProperty('location_check_points')) {
            document.getElementById('points-per-check').innerText = command.location_check_points.toString();
          }

          if (command.hasOwnProperty('hint_points')) {
            document.getElementById('hint-points').innerText = command.hint_points.toString();
          }

          // Run game-specific handler
          await gameInstance.RoomUpdate(command);
          break;

        case 'Print':
          appendConsoleMessage(command.text);

          // Run game-specific handler
          await gameInstance.Print(command);
          break;

        case 'PrintJSON':
          appendFormattedConsoleMessage(command.data);

          // Run game-specific handler
          await gameInstance.PrintJSON(command);
          break;

        case 'DataPackage':
          // Save updated data package into localStorage
          if (command.data.version !== 0) { // Unless this is a custom package, denoted by version zero
            localStorage.setItem('dataPackageVersion', command.data.version);
            localStorage.setItem('dataPackage', JSON.stringify(command.data));
          }
          buildItemAndLocationData(command.data);

          // Run game-specific handler
          await gameInstance.DataPackage(command);
          break;

        case 'Bounced':
          // This command can be used for a variety of things. Currently, it is used for keep-alive and DeathLink.
          // keep-alive packets can be safely ignored

          // DeathLink handling
          if (
            command.hasOwnProperty('tags') && // If there are tags on this message
            command.tags.includes('DeathLink') && // If those tags include DeathLink
            await gameInstance.isDeathLinkEnabled() // If DeathLink is enabled
          ) {
            if (
              (deathLinkState === DEATH_LINK_ALIVE) && // The player was last known to be alive
              ((lastDeathLink + DEATH_LINK_COOLDOWN) < new Date().getTime()) // Cooldown has passed
            ) {
              // Update the DeathLink state and wait a split second
              deathLinkState = DEATH_LINK_KILLING;
              lastDeathLink = new Date().getTime();
              await new Promise((resolve) => setTimeout(resolve, 50));

              // Kill the player and print a message to the console informing the player of who is responsible
              gameInstance.killPlayer().then(() => {
                if (command.data.hasOwnProperty('cause') && command.data.cause) {
                  appendConsoleMessage(command.data.cause);
                  return;
                }
                appendConsoleMessage(getRandomDeathLinkMessage(command.data.source));
              });
            }
          }

          await gameInstance.Bounced(command);
          break;

        default:
          // Unhandled events are ignored
          break;
      }
    }
  };

  serverSocket.onclose = (event) => {
    const serverStatus = document.getElementById('server-status');
    serverStatus.classList.remove('connected');
    serverStatus.innerText = 'Not Connected';
    serverStatus.classList.add('disconnected');

    // If the user cleared the server address, do nothing
    const serverAddress = document.getElementById('server-address').value;
    if (preventReconnect || !serverAddress) { return; }

    // If no SNES device is currently selected, do nothing
    if (snesDevice === null) { return; }

    // Do not allow simultaneous reconnection attempts
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }

    // Attempt to reconnect to the AP server
    reconnectTimeout = setTimeout(() => {
      // Do not attempt to reconnect if a server connection exists already. This can happen if a user attempts
      // to connect to a new server after connecting to a previous one
      if (serverSocket && serverSocket.readyState === WebSocket.OPEN) { return; }

      // If the socket was closed in response to an auth error, do not reconnect
      if (serverAuthError) { return; }

      // If reconnection is currently prohibited for any other reason, do not attempt to reconnect
      if (preventReconnect) { return; }

      // Do not exceed the limit of reconnection attempts
      if (++reconnectAttempts > maxReconnectAttempts) {
        appendConsoleMessage('Archipelago server connection lost. The connection closed unexpectedly. ' +
          'Please try to reconnect, or restart the client.');
        return;
      }

      appendConsoleMessage(`Connection to AP server lost. Attempting to reconnect ` +
        `(${reconnectAttempts} of ${maxReconnectAttempts})`);
      connectToServer(address, serverPassword);
    }, 5000);
  };

  serverSocket.onerror = (event) => {
    if (serverSocket && serverSocket.readyState === WebSocket.OPEN) {
      appendConsoleMessage('Archipelago server connection lost. The connection closed unexpectedly. ' +
        'Please try to reconnect, or restart the client.');
      serverSocket.close();
    }
  };
};

const getClientId = () => {
  let clientId = localStorage.getItem('clientId');
  if (!clientId) {
    clientId = (Math.random() * 10000000000000000).toString();
    localStorage.setItem('clientId', clientId);
  }
  return clientId;
};

const sendMessageToServer = (message) => {
  if (serverSocket && serverSocket.readyState === WebSocket.OPEN) {
    serverSocket.send(JSON.stringify([{
      cmd: 'Say',
      text: message,
    }]));
  }
};

const serverSync = () => {
  if (serverSocket && serverSocket.readyState === WebSocket.OPEN) {
    serverSocket.send(JSON.stringify([{ cmd: 'Sync' }]));
  }
};

const requestDataPackage = () => {
  if (!serverSocket || serverSocket.readyState !== WebSocket.OPEN) { return; }
  serverSocket.send(JSON.stringify([{
    cmd: 'GetDataPackage',
  }]));
};

const buildItemAndLocationData = (dataPackage) => {
  Object.keys(dataPackage.games).forEach((gameName) => {
    apItemsByName = Object.assign({}, apItemsByName, dataPackage.games[gameName].item_name_to_id);
    apLocationsByName = Object.assign({}, apLocationsByName, dataPackage.games[gameName].location_name_to_id);

    // Build itemId map
    Object.keys(dataPackage.games[gameName].item_name_to_id).forEach((itemName) => {
      apItemsById[dataPackage.games[gameName].item_name_to_id[itemName]] = itemName;

    });

    // Build locationId map
    Object.keys(dataPackage.games[gameName].location_name_to_id).forEach((locationName) => {
      apLocationsById[dataPackage.games[gameName].location_name_to_id[locationName]] = locationName;
    });
  });
};
