/**
 * Handles network commands received from the AP server.
 * Each method name should be the same as the `cmd`.
 */
class GameInstance {
  /** Instance Variables */
  // Item tracking
  checkedLocations = [];
  missingLocations = [];
  itemsReceived = [];
  scoutedLocations = {}; // Data about remote items

  // Custom item maps
  locationsById = { underworld: {}, overworld: {}, npc: {}, misc: {} };
  locationsByRoomId = { underworld: {}, overworld: {}, npc: {}, misc: {} };

  // Has DeathLink been enabled?
  deathLinkEnabled = null;
  lastForcedDeath = new Date().getTime(); // Tracks the last time a death was send or received over the network
  playerIsDead = false;
  playerIsStillDead = false;

  // Game state tracking
  gameCompleted = false; // If the client has previously notified the server the game was completed

  constructor() {
    // Maybe do something here
  }

  /**
   * Authenticate with the AP server
   * @returns {Promise<void>}
   */
  authenticate = async () => {
      // Build tags used in authentication below
    const tags = ['Super Nintendo Client'];
    if (deathLinkEnabled) { tags.push('DeathLink'); }

    // Authenticate with the server
    const romName = await readFromAddress(ROMNAME_START, ROMNAME_SIZE);
    const connectionData = {
      cmd: 'Connect',
      game: 'A Link to the Past',
      name: btoa(new TextDecoder().decode(romName)), // Base64 encoded rom name
      uuid: getClientId(),
      tags: tags,
      password: serverPassword,
      version: ARCHIPELAGO_PROTOCOL_VERSION,
    };
    serverSocket.send(JSON.stringify([connectionData]));
  };

  /**
   * Received after the client first establishes a connection with the WebSocket server hosted by AP.
   * This is typically used to indicate the server is ready to process an authentication message.
   * @param command
   * @returns {Promise<void>}
   * @constructor
   */
  RoomInfo = async (command) => {
    // Build custom location data
    const locationIds = Object.keys(apLocationsById['A Link to the Past']);
    const locationNames = Object.values(apLocationsById['A Link to the Past']);

    Object.keys(UNDERWORLD_LOCATIONS).forEach((uwLocationName) => {
      this.locationsById['underworld'][locationIds[locationNames.indexOf(uwLocationName)]] = {
        name: uwLocationName,
        locationId: Number(locationIds[locationNames.indexOf(uwLocationName)]),
        roomId: UNDERWORLD_LOCATIONS[uwLocationName][0],
        mask: UNDERWORLD_LOCATIONS[uwLocationName][1],
      }

      if (!this.locationsByRoomId['underworld'].hasOwnProperty(UNDERWORLD_LOCATIONS[uwLocationName][0])) {
        this.locationsByRoomId['underworld'][UNDERWORLD_LOCATIONS[uwLocationName][0]] = [];
      }
      this.locationsByRoomId['underworld'][UNDERWORLD_LOCATIONS[uwLocationName][0]].push({
        name: uwLocationName,
        locationId: Number(locationIds[locationNames.indexOf(uwLocationName)]),
        roomId: UNDERWORLD_LOCATIONS[uwLocationName][0],
        mask: UNDERWORLD_LOCATIONS[uwLocationName][1],
      });
    });

    Object.keys(OVERWORLD_LOCATIONS).forEach((owLocationName) => {
      this.locationsById['overworld'][locationIds[locationNames.indexOf(owLocationName)]] = {
        name: owLocationName,
        locationId: Number(locationIds[locationNames.indexOf(owLocationName)]),
        screenId: OVERWORLD_LOCATIONS[owLocationName],
        mask: null,
      };

      if (!this.locationsByRoomId['overworld'].hasOwnProperty(OVERWORLD_LOCATIONS[owLocationName])) {
        this.locationsByRoomId['overworld'][OVERWORLD_LOCATIONS[owLocationName]] = [];
      }
      this.locationsByRoomId['overworld'][OVERWORLD_LOCATIONS[owLocationName]].push({
        name: owLocationName,
        locationId: Number(locationIds[locationNames.indexOf(owLocationName)]),
        screenId: OVERWORLD_LOCATIONS[owLocationName],
        mask: null,
      });
    });

    Object.keys(NPC_LOCATIONS).forEach((npcLocationName) => {
      this.locationsById['npc'][locationIds[locationNames.indexOf(npcLocationName)]] = {
        name: npcLocationName,
        locationId: Number(locationIds[locationNames.indexOf(npcLocationName)]),
        screenId: NPC_LOCATIONS[npcLocationName],
        mask: null,
      };

      if (!this.locationsByRoomId['npc'].hasOwnProperty(NPC_LOCATIONS[npcLocationName])) {
        this.locationsByRoomId['npc'][NPC_LOCATIONS[npcLocationName]] = [];
      }
      this.locationsByRoomId['npc'][NPC_LOCATIONS[npcLocationName]].push({
        name: npcLocationName,
        locationId: Number(locationIds[locationNames.indexOf(npcLocationName)]),
        screenId: NPC_LOCATIONS[npcLocationName],
        mask: null,
      });
    });

    Object.keys(MISC_LOCATIONS).forEach((miscLocationName) => {
      this.locationsById['misc'][locationIds[locationNames.indexOf(miscLocationName)]] = {
        name: miscLocationName,
        locationId: Number(locationIds[locationNames.indexOf(miscLocationName)]),
        roomId: MISC_LOCATIONS[miscLocationName][0],
        mask: MISC_LOCATIONS[miscLocationName][1],
      };

      if (!this.locationsByRoomId['misc'].hasOwnProperty(MISC_LOCATIONS[miscLocationName][0])) {
        this.locationsByRoomId['misc'][MISC_LOCATIONS[miscLocationName][0]] = [];
      }
      this.locationsByRoomId['misc'][MISC_LOCATIONS[miscLocationName][0]].push({
        name: miscLocationName,
        locationId: Number(locationIds[locationNames.indexOf(miscLocationName)]),
        roomId: MISC_LOCATIONS[miscLocationName][0],
        mask: MISC_LOCATIONS[miscLocationName][1],
      });
    });
  };

  /**
   * Received when the client has successfully authenticated with the AP server. This is used to indicate
   * the client is ready to begin the client logic loop
   * @param command
   * @returns {Promise<void>}
   * @constructor
   */
  Connected = async (command) => {
    // Store the reported location check data from the server. They are arrays of locationIds
    this.checkedLocations = command.checked_locations;
    this.missingLocations = command.missing_locations;

    // In case the user replaced the ROM without disconnecting from the AP Server or SNI, treat every new
    // 'Connected' message as if it means a new ROM was discovered
    this.itemsReceived = [];

    // Determine if DeathLink is enabled
    const deathLinkFlag = await readFromAddress(DEATH_LINK_ACTIVE_ADDR, 1);
    this.deathLinkEnabled = parseInt(deathLinkFlag[0], 10) === 1;
  };

  /**
   * Received when the client's authentication is refused by the AP server.
   * @param command
   * @returns {Promise<void>}
   * @constructor
   */
  ConnectionRefused = async (command) => {};

  /**
   * Received when the client is notified that items should be granted to the player
   * @param command
   * @returns {Promise<void>}
   * @constructor
   */
  ReceivedItems = async (command) => {
    // Save received items in the array of items to be sent to the SNES, if they have not been sent already
    command.items.forEach((item) => {
      // Items from locations with id 0 or lower are special cases, and should always be allowed
      if (item.location <= 0) { return this.itemsReceived.push(item); }

      if (this.itemsReceived.find((ir) =>
        ir.item === item.item && ir.location === item.location && ir.player === item.player
      )) { return; }
      this.itemsReceived.push(item);
    });
  };

  /**
   * Handle location scout confirmations
   * @param command
   * @returns {Promise<void>}
   * @constructor
   */
  LocationInfo = async (command) => {
    // This packet is received as a confirmation from the server that a location has been scouted.
    // Once the server confirms a scout, it sends the confirmed data back to the client. Here, we
    // store the confirmed scouted locations in an object.
    command.locations.forEach((location) => {
      // location = [ item, location, player ]
      if (!this.scoutedLocations.hasOwnProperty(location.location)) {
        this.scoutedLocations[location.location] = {
          item: location[0],
          player: location[2],
        };
      }
    });
  };

  /**
   * Received when the server sends an update to the room information.
   * @param command
   * @returns {Promise<void>}
   * @constructor
   */
  RoomUpdate = async (command) => {};

  /**
   * Received when the server intends to print a message to the client.
   * @param command
   * @returns {Promise<void>}
   * @constructor
   */
  Print = async (command) => {};

  /**
   * Received when the server intends to print a formatted message to the client.
   * @param command
   * @returns {Promise<void>}
   * @constructor
   */
  PrintJSON = async (command) => {};

  /**
   * Received when the server delivers an updated DataPackage.
   * @param command
   * @returns {Promise<void>}
   * @constructor
   */
  DataPackage = async (command) => {};

  /**
   * Received for a variety of reasons.
   * @param command
   * @returns {Promise<void>}
   * @constructor
   */
  Bounced = async (command) => {
    if (command.tags.includes('DeathLink')) {
      // Has it been at least ten seconds since the last time Link was forcibly killed?
      if (this.deathLinkEnabled && (new Date().getTime() > (this.lastForcedDeath + 10000))) {
        // Notify the player of the DeathLink occurrence, and who is to blame
        appendConsoleMessage(`${command.data.source} has died, and took you with them.`)

        // Kill Link
        this.playerIsDead = this.playerIsStillDead = true;
        this.lastForcedDeath = new Date().getTime();

        // Set the current health value to zero
        let healthValue = new Uint8Array(1);
        healthValue.set([0]);
        await writeToAddress(WRAM_START + 0xF36D, healthValue);

        // Deal eight damage to Link
        let damageAmount = new Uint8Array(1);
        damageAmount.set([8]);
        await writeToAddress(WRAM_START + 0x0373, damageAmount);
      }
    }
  };

  /**
   * Run a single iteration of the client logic. Scan for location checks, send received items, etc.
   * @returns {Promise<unknown>}
   */
  runClientLogic = () => new Promise(async (resolve, reject) => {
    try{
      // Fetch game mode
      const gameMode = await readFromAddress(WRAM_START + 0x10, 0x01);
      const modeValue = gameMode[0];
      // If game mode is unknown or not present, do not attempt to fetch or write data to the SNES
      if (!modeValue || (
        !INGAME_MODES.includes(modeValue) &&
        !ENDGAME_MODES.includes(modeValue) &&
        !DEATH_MODES.includes(modeValue)
      )) {
        return resolve();
      }

      // Check if DeathLink is enabled and Link is dead
      if (this.deathLinkEnabled && this.playerIsDead) {
        // Determine if link is currently dead, and therefore if he is able to be killed
        if (!this.playerIsStillDead) { // Link is dead, and it just happened
          // Keep track of Link's state to prevent sending multiple DeathLink signals per death
          this.playerIsStillDead = true;

          // Check if it has been at least ten seconds since the last DeathLink network signal
          // was sent or received
          if (new Date().getTime() > (this.lastForcedDeath + 10000)) {
            if (serverSocket && serverSocket.readyState === WebSocket.OPEN) {
              // Link just died, so ignore DeathLink signals for the next ten seconds
              this.lastForcedDeath = new Date().getTime();
              serverSocket.send(JSON.stringify([{
                cmd: 'Bounce',
                tags: ['DeathLink'],
                data: {
                  time: Math.floor(this.lastForcedDeath / 1000), // Unix Timestamp
                  source: players.find((player) =>
                    (player.team === playerTeam) && (player.slot === playerSlot)).alias, // Local player alias
                },
              }]));
            }

            return resolve();
          }
        }
      }

      // Determine if Link is currently dead
      this.playerIsDead = DEATH_MODES.includes(modeValue);
      if (!this.playerIsDead) { this.playerIsStillDead = false; }

      // Fetch game state and triforce information
      const gameOverScreenDisplayed = await readFromAddress(SAVEDATA_START + 0x443, 0x01);
      // If the game over screen is displayed, do not send or receive items
      if (gameOverScreenDisplayed[0] || ENDGAME_MODES.indexOf(modeValue) > -1) {
        // If this is the first time the game over screen is displayed, inform the server
        // the game is complete.
        if (serverSocket && serverSocket.readyState === WebSocket.OPEN && !this.gameCompleted) {
          serverSocket.send(JSON.stringify([{
            cmd: 'StatusUpdate',
            status: CLIENT_STATUS.CLIENT_GOAL,
          }]));

          // Flag game as completed
          this.gameCompleted = true;
        }

        return resolve();
      }

      // Fetch information from the SNES about items it has received, and compare that against local data.
      // This fetch includes data about the room the player is currently inside of
      const receivedItems = await readFromAddress(RECEIVED_ITEMS_INDEX, 0x08);
      const romItemsReceived = receivedItems[0] | (receivedItems[1] << 8);
      const linkIsBusy = receivedItems[2];
      const roomId = receivedItems[4] | (receivedItems[5] << 8);
      const roomData = receivedItems[6];
      const scoutLocation = receivedItems[7];

      // If there are still items needing to be sent, and Link is able to receive an item,
      // send the item to the SNES
      if (receiveItems && (romItemsReceived < this.itemsReceived.length) && !linkIsBusy) {
        // Increment the counter of items sent to the ROM
        const indexData = new Uint8Array(2);
        indexData.set([
          (romItemsReceived + 1) & 0xFF,
          ((romItemsReceived + 1) >> 8) & 0xFF,
        ]);
        await writeToAddress(RECEIVED_ITEMS_INDEX, indexData);

        // Send the item to the SNES
        const itemData = new Uint8Array(1);
        itemData.set([this.itemsReceived[romItemsReceived].item])
        await writeToAddress(RECEIVED_ITEM_ADDRESS, itemData);

        // Tell the SNES the id of the player who sent the item
        const senderData = new Uint8Array(1);
        senderData.set([
          // Because LttP can only hold 255 player names, if the sending player's ID is greater
          // than 255, we always send 255. Player 255 is always written to the ROM as "Archipelago"
          (playerSlot === this.itemsReceived[romItemsReceived].player) ? 0 : (
            Math.min(this.itemsReceived[romItemsReceived].player, 255)
          )
        ]);
        await writeToAddress(RECEIVED_ITEM_SENDER_ADDRESS, senderData);
      }

      // If the player's current location has a scout item (an item laying on the ground), we need to
      // send that item's ID to the server so it can tell us what that item is, then we need to update
      // the SNES with the item data. This is mostly useful for remote item games, which Z3 does not
      // yet implement, but may in the future.
      if (scoutLocation > 0){
        // If the scouted item is not in the list of scouted locations stored by the client, send
        // the scout data to the server
        if (!this.scoutedLocations.hasOwnProperty(scoutLocation)) {
          serverSocket.send(JSON.stringify([{
            cmd: 'LocationScouts',
            locations: [scoutLocation],
          }]));
        } else {
          // If the scouted item is present in the list of scout locations stored by the client, we
          // update the SNES with information about the item
          const locationData = new Uint8Array(1);
          locationData.set([scoutLocation]);
          await writeToAddress(SCOUTREPLY_LOCATION_ADDR, locationData);

          const scoutItemData = new Uint8Array(1);
          scoutItemData.set([this.scoutedLocations[scoutLocation].item]);
          await writeToAddress(SCOUTREPLY_ITEM_ADDR, scoutItemData);

          const playerData = new Uint8Array(1);
          playerData.set([this.scoutedLocations[scoutLocation].player]);
          await writeToAddress(SCOUTREPLY_PLAYER_ADDR, playerData);
        }
      }

      // If the player is currently inside a shop
      if (shopIds.indexOf(roomId) > -1) {
        // Request shop data from every shop in the game
        const requestLength = (Object.keys(SHOPS).length * 3) + 5;
        const shopData = await readFromAddress(SHOP_ADDR, requestLength);
        // Update the purchase status of every item in every shop. This is important because
        // multiple shops can sell the same item, like a quiver when in retro mode
        const newChecks = [];
        for (let index = 0; index < requestLength; ++index) {
          if (shopData[index] && this.checkedLocations.indexOf(SHOP_ID_START + index) === -1) {
            newChecks.push(SHOP_ID_START + index)
          }
        }
        if (newChecks.length > 0) { this.sendLocationChecks(newChecks); }
      }

      // TODO: Is this chunk of code necessary? All item locations are scanned below this block
      // If the current room is unknown, do nothing. This happens if no check has been made yet
      if (this.locationsByRoomId.hasOwnProperty(roomId)) {
        // If there are new checks in this room, send them to the server
        const newChecks = [];
        for (const location of this.locationsByRoomId['underworld'][roomId]) {
          if (this.checkedLocations.indexOf(location.locationId) > -1) { continue; }
          if (((roomData << 4) & location.mask) !== 0) {
            newChecks.push(location.locationId);
          }
        }
        this.sendLocationChecks(newChecks);
      }

      // In the below loops, the entire SNES data is pulled to see if any items have already
      // been obtained. The client must do this because it's possible for a player to begin
      // picking up items before they connect to the server. It must then continue to do this
      // because it's possible for a player to disconnect, pick up items, then reconnect

      // Look for any checked locations in the underworld, and send those to the server if they have
      // not been sent already. Also track the earliest unavailable data, as we will fetch it later
      let underworldBegin = 0x129;
      let underworldEnd = 0;
      const underworldMissing = [];
      for (const location of Object.values(this.locationsById['underworld'])) {
        if (this.checkedLocations.indexOf(location.locationId) > -1) { continue; }
        underworldMissing.push(location);
        underworldBegin = Math.min(underworldBegin, location.roomId);
        underworldEnd = Math.max(underworldEnd, location.roomId + 1);
      }
      // The data originally fetched may not cover all of the underworld items, so the client needs to
      // fetch the remaining items to see if they have been previously obtained
      if (underworldBegin < underworldEnd) {
        const uwResults = await readFromAddress(SAVEDATA_START + (underworldBegin * 2),
          (underworldEnd - underworldBegin) * 2);
        const newChecks = [];
        for (const location of underworldMissing) {
          const dataOffset = (location.roomId - underworldBegin) * 2;
          const roomData = uwResults[dataOffset] | (uwResults[dataOffset + 1] << 8);
          if ((roomData & location.mask) !== 0) {
            newChecks.push(location.locationId);
          }
        }
        // Send new checks if there are any
        if (newChecks.length > 0) { this.sendLocationChecks(newChecks); }
      }

      // Look for any checked locations in the overworld, and send those to the server if they have
      // not been sent already. Also track the earliest unavailable data, as we will fetch it later
      let overworldBegin = 0x82;
      let overworldEnd = 0;
      const overworldMissing = [];
      for (const location of Object.values(this.locationsById['overworld'])) {
        if (this.checkedLocations.indexOf(location.locationId) > -1) { continue; }
        overworldMissing.push(location);
        overworldBegin = Math.min(overworldBegin, location.screenId);
        overworldEnd = Math.max(overworldEnd, location.screenId + 1);
      }
      // The data originally fetched may not cover all of the overworld items, so the client needs to
      // fetch the remaining items to see if they have been previously obtained
      if (overworldBegin < overworldEnd) {
        const owResults = await readFromAddress(SAVEDATA_START + 0x280 + overworldBegin, overworldEnd - overworldBegin);
        const newChecks = [];
        for (const location of overworldMissing) {
          if ((owResults[location.screenId - overworldBegin] & 0x40) !== 0) {
            newChecks.push(location.locationId);
          }
        }
        // Send new checks if there are any
        if (newChecks.length > 0) { this.sendLocationChecks(newChecks); }
      }

      // If all NPC locations have not been checked, pull npc data
      let npcAllChecked = true;
      for (const location of Object.values(this.locationsById['npc'])) {
        if (this.checkedLocations.indexOf(location.locationId) === -1) {
          npcAllChecked = false;
          break;
        }
      }
      if (!npcAllChecked) {
        const npcResults = await readFromAddress(SAVEDATA_START + 0x410, 2);
        const npcValue = npcResults[0] | (npcResults[1] << 8);
        const newChecks = [];
        for (const location of Object.values(this.locationsById['npc'])) {
          if (this.checkedLocations.indexOf(location.locationId) > -1) { continue; }
          if ((npcValue & location.screenId) !== 0) {
            newChecks.push(location.locationId);
          }
        }
        // Send new checks if there are any
        if (newChecks.length > 0) { this.sendLocationChecks(newChecks); }
      }

      // If all misc locations have not been checked, pull misc data
      let miscAllChecked = true;
      for (const location of Object.values(this.locationsById['misc'])) {
        if (this.checkedLocations.indexOf(location.locationId) === -1) {
          miscAllChecked = false;
          break;
        }
      }
      if (!miscAllChecked) {
        const miscResults = await readFromAddress(SAVEDATA_START + 0x3c6, 4);
        const newChecks = [];
        for (const location of Object.values(this.locationsById['misc'])) {
          // What the hell is this assert for? It's always true based on data from romData.js
          // Anyway, it's preserved from the original client code, but not used here
          // console.assert(0x3c6 <= location.roomId <= 0x3c9);
          if (this.checkedLocations.indexOf(location.locationId) > -1) { continue; }
          if ((miscResults[location.roomId - 0x3c6] & location.mask) !== 0) {
            newChecks.push(location.locationId);
          }
        }
        // Send new checks if there are any
        if (newChecks.length > 0) { this.sendLocationChecks(newChecks); }
      }

      // SNES interaction complete for this loop
      resolve();
    } catch (err) {
      // Reject with whatever went wrong
      reject(err);
    }
  });

  /**
   * Append to the local list of location checks, and inform the AP server of new checks
   * @param locationIds
   */
  sendLocationChecks = (locationIds) => {
    locationIds.forEach((id) => this.checkedLocations.push(id));
    serverSocket.send(JSON.stringify([{
      cmd: 'LocationChecks',
      locations: locationIds,
    }]));
  };
}
