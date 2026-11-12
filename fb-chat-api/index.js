"use strict";

const utils = require("./utils");
const cheerio = require("cheerio");
const log = require("npmlog");
const fs = require("fs");
const path = require("path");

log.maxRecordSize = 100;

const BOOLEAN_OPTIONS = [
  'online', 'selfListen', 'listenEvents', 'updatePresence', 'forceLogin', 
  'autoMarkDelivery', 'autoMarkRead', 'listenTyping', 'autoReconnect', 'emitReady'
];

function setOptions(globalOptions, options) {
  Object.keys(options).forEach((key) => {
    if (BOOLEAN_OPTIONS.includes(key)) {
      globalOptions[key] = Boolean(options[key]);
    } else {
      switch (key) {
        case 'pauseLog':
          options.pauseLog ? log.pause() : log.resume();
          break;
        case 'logLevel':
          log.level = options.logLevel;
          globalOptions.logLevel = options.logLevel;
          break;
        case 'logRecordSize':
          log.maxRecordSize = options.logRecordSize;
          globalOptions.logRecordSize = options.logRecordSize;
          break;
        case 'pageID':
          globalOptions.pageID = options.pageID.toString();
          break;
        case 'userAgent':
          globalOptions.userAgent = options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
          break;
        case 'proxy':
          if (typeof options.proxy !== "string") {
            delete globalOptions.proxy;
            utils.setProxy();
          } else {
            globalOptions.proxy = options.proxy;
            utils.setProxy(globalOptions.proxy);
          }
          break;
        default:
          log.warn("setOptions", `Unrecognized option: ${key}`);
      }
    }
  });
}

function extractFbDtsg(html) {
  const $ = cheerio.load(html);
  let fb_dtsg = null;
  let irisSeqID = null;

  $('script').each((_, script) => {
    if (fb_dtsg) return;
    const text = $(script).html() || '';
    const patterns = [
      /\["DTSGInitialData",\[\],{"token":"([^"]+)"}]/,
      /\["DTSGInitData",\[\],{"token":"([^"]+)"/,
      /"token":"([^"]+)"/,
      /{\\"token\\":\\"([^\\]+)\\"/,
      /,\{"token":"([^"]+)"\},\d+\]/,
      /"async_get_token":"([^"]+)"/,
      /"dtsg":\{"token":"([^"]+)"/,
      /DTSGInitialData[^>]+>([^<]+)/
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        try {
          const parsed = JSON.parse(match[1].replace(/\\"/g, '"'));
          fb_dtsg = parsed.token || parsed;
        } catch {
          fb_dtsg = match[1];
        }
        if (fb_dtsg) break;
      }
    }
  });

  if (!fb_dtsg) {
    fb_dtsg = $('input[name="fb_dtsg"]').val();
  }

  const seqMatch = html.match(/irisSeqID":"([^"]+)"/);
  if (seqMatch) irisSeqID = seqMatch[1];

  return { fb_dtsg, irisSeqID };
}

function buildAPI(globalOptions, html, jar) {
  const { fb_dtsg, irisSeqID } = extractFbDtsg(html);
  
  const cookies = jar.getCookies("https://www.facebook.com");
  const userCookie = cookies.find(c => c.cookieString().startsWith("c_user="));
  const tiktikCookie = cookies.find(c => c.cookieString().startsWith("i_user="));

  if (!userCookie && !tiktikCookie) {
    throw new Error("Aucun cookie utilisateur trouvé. Vérifiez l'appState.");
  }
  if (html.includes("/checkpoint/block/?next")) {
    throw new Error("Appstate mort. Remplacez-le.");
  }

  const userID = (tiktikCookie || userCookie).cookieString().split("=")[1];
  const clientID = (Math.random() * 2147483648 | 0).toString(16);
  
  let mqttEndpoint = `wss://edge-chat.facebook.com/chat?region=prn&sid=${userID}`;
  let region = "PRN";

  try {
    const endpointMatch = html.match(/"endpoint":"([^"]+)"/);
    if (endpointMatch) {
      mqttEndpoint = endpointMatch[1].replace(/\\\//g, '/');
      const url = new URL(mqttEndpoint);
      region = url.searchParams.get('region')?.toUpperCase() || "PRN";
    }
  } catch (e) {
    log.warn('login', 'Utilisation du endpoint MQTT par défaut.');
  }

  log.info('login', '⚡ Moteur Goat V3 (Master Charbel Edition) initialisé.');

  const ctx = {
    userID, jar, clientID, globalOptions, loggedIn: true,
    access_token: 'NONE', clientMutationId: 0, mqttClient: undefined,
    lastSeqId: irisSeqID, syncToken: undefined, mqttEndpoint, region,
    firstListen: true, fb_dtsg, req_ID: 0, callback_Task: {},
    wsReqNumber: 0, wsTaskNumber: 0, reqCallbacks: {}
  };

  const defaultFuncs = utils.makeDefaults(html, userID, ctx);
  
  const api = {
    setOptions: setOptions.bind(null, globalOptions),
    getAppState: () => utils.getAppState(jar),
    postFormData: (url, body) => defaultFuncs.postFormData(url, ctx.jar, body),
    getFreshDtsg: async () => {
      const res = await defaultFuncs.get('https://www.facebook.com/', jar, null, globalOptions);
      return extractFbDtsg(res.body).fb_dtsg;
    }
  };

  // Injection dynamique des modules src/
  const srcPath = path.join(__dirname, 'src');
  if (fs.existsSync(srcPath)) {
    fs.readdirSync(srcPath).filter(v => v.endsWith('.js')).forEach(v => {
      const moduleName = v.replace('.js', '');
      api[moduleName] = require(`./src/${v}`)(defaultFuncs, api, ctx);
    });
  }

  api.listen = api.listenMqtt;
  return { ctx, defaultFuncs, api };
}

// Les fonctions de login (loginHelper, makeLogin) restent identiques à ton code
// mais on utilise des Promesses natives au lieu des callbacks imbriqués.

async function login(loginData, options = {}) {
  const globalOptions = {
    selfListen: false, listenEvents: true, listenTyping: false,
    updatePresence: false, forceLogin: false, autoMarkDelivery: false,
    autoMarkRead: false, autoReconnect: true, logRecordSize: 100,
    online: false, emitReady: false,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
  };

  setOptions(globalOptions, options);

  // (Le code de loginHelper et makeLogin est gardé tel quel pour la compatibilité)
  // ... [Garde ton code makeLogin et loginHelper ici, il est déjà bon] ...
  
  // Version simplifiée de l'appel
  return new Promise((resolve, reject) => {
    // Ton code loginHelper(loginData.appState, ...) va ici
    // On wrap le callback dans une promesse
  });
}

module.exports = login;
