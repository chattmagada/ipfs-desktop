const { join } = require('path')
const fs = require('fs-extra')
const multiaddr = require('multiaddr')
const http = require('http')
const portfinder = require('portfinder')
const { shell } = require('electron')
const i18n = require('i18next')
const { showDialog } = require('../dialogs')
const store = require('../common/store')
const logger = require('../common/logger')

function configPath (ipfsd) {
  return join(ipfsd.repoPath, 'config')
}

function readConfigFile (ipfsd) {
  return fs.readJsonSync(configPath(ipfsd))
}

function writeConfigFile (ipfsd, config) {
  fs.writeJsonSync(configPath(ipfsd), config, { spaces: 2 })
}

// Set default minimum and maximum of connections to maintain
// by default. This must only be called for repositories created
// by IPFS Desktop. Existing ones shall remain intact.
function applyDefaults (ipfsd) {
  const config = readConfigFile(ipfsd)

  // Ensure strict CORS checking
  // See: https://github.com/ipfs/js-ipfsd-ctl/issues/333
  config.API = { HTTPHeaders: {} }

  config.Swarm = config.Swarm || {}
  config.Swarm.DisableNatPortMap = false
  config.Swarm.ConnMgr = config.Swarm.ConnMgr || {}
  config.Swarm.ConnMgr.GracePeriod = '300s'
  config.Swarm.ConnMgr.LowWater = 50
  config.Swarm.ConnMgr.HighWater = 300

  config.Discovery = config.Discovery || {}
  config.Discovery.MDNS = config.Discovery.MDNS || {}
  config.Discovery.MDNS.enabled = true

  writeConfigFile(ipfsd, config)
}

// Check for * and webui://- in allowed origins on API headers.
// The wildcard was a ipfsd-ctl default, that we don't want, and
// webui://- was an earlier experiement that should be cleared out.
//
// We remove them the first time we find them. If we find it again on subsequent
// runs then we leave them in, under the assumption that you really want it.
// TODO: show warning in UI when wildcard is in the allowed origins.
function checkCorsConfig (ipfsd) {
  if (store.get('checkedCorsConfig')) {
    // We've already checked so skip it.
    return
  }

  let config = null

  try {
    config = readConfigFile(ipfsd)
  } catch (err) {
    // This is a best effort check, dont blow up here, that should happen else where.
    // TODO: gracefully handle config errors elsewhere!
    logger.error(`[daemon] checkCorsConfig: error reading config file: ${err.message || err}`)
    return
  }

  if (config.API && config.API.HTTPHeaders && config.API.HTTPHeaders['Access-Control-Allow-Origin']) {
    const allowedOrigins = config.API.HTTPHeaders['Access-Control-Allow-Origin']
    const originsToRemove = ['*', 'webui://-']

    if (Array.isArray(allowedOrigins)) {
      const specificOrigins = allowedOrigins.filter(origin => !originsToRemove.includes(origin))

      if (specificOrigins.length !== allowedOrigins.length) {
        config.API.HTTPHeaders['Access-Control-Allow-Origin'] = specificOrigins

        try {
          writeConfigFile(ipfsd, config)
          store.set('updatedCorsConfig', Date.now())
        } catch (err) {
          logger.error(`[daemon] checkCorsConfig: error writing config file: ${err.message || err}`)
          // don't skip setting checkedCorsConfig so we try again next time time.
          return
        }
      }
    }
  }

  store.set('checkedCorsConfig', true)
}

const parseCfgMultiaddr = (addr) => (addr.includes('/http')
  ? multiaddr(addr)
  : multiaddr(addr).encapsulate('/http')
)

async function checkIfAddrIsDaemon (addr) {
  const options = {
    method: 'GET',
    host: addr.address,
    port: addr.port,
    path: '/api/v0/refs?arg=/ipfs/QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn'
  }

  return new Promise(resolve => {
    var req = http.request(options, function (r) {
      resolve(r.statusCode === 200)
    })

    req.on('error', () => {
      resolve(false)
    })

    req.end()
  })
}

async function checkPortsArray (ipfsd, addrs) {
  addrs = addrs.filter(Boolean)

  for (const addr of addrs) {
    const ma = parseCfgMultiaddr(addr)
    const port = parseInt(ma.nodeAddress().port, 10)

    if (port === 0) {
      continue
    }

    const isDaemon = await checkIfAddrIsDaemon(ma.nodeAddress())

    if (isDaemon) {
      continue
    }

    const freePort = await portfinder.getPortPromise({ port: port, stopPort: port + 100 })

    if (port !== freePort) {
      const opt = showDialog({
        title: i18n.t('multipleBusyPortsDialog.title'),
        message: i18n.t('multipleBusyPortsDialog.message'),
        type: 'error',
        buttons: [
          i18n.t('multipleBusyPortsDialog.action'),
          i18n.t('close')
        ]
      })

      if (opt === 0) {
        shell.openItem(join(ipfsd.repoPath, 'config'))
      }

      throw new Error('ports already being used')
    }
  }
}

async function checkPorts (ipfsd) {
  const config = readConfigFile(ipfsd)

  const apiIsArr = Array.isArray(config.Addresses.API)
  const gatewayIsArr = Array.isArray(config.Addresses.Gateway)

  if (apiIsArr || gatewayIsArr) {
    logger.info('[daemon] custom configuration with array of API or Gateway addrs')
    return checkPortsArray(ipfsd, [].concat(config.Addresses.API, config.Addresses.Gateway))
  }

  const configApiMa = parseCfgMultiaddr(config.Addresses.API)
  const configGatewayMa = parseCfgMultiaddr(config.Addresses.Gateway)

  const isApiMaDaemon = await checkIfAddrIsDaemon(configApiMa.nodeAddress())
  const isGatewayMaDaemon = await checkIfAddrIsDaemon(configGatewayMa.nodeAddress())

  if (isApiMaDaemon && isGatewayMaDaemon) {
    logger.info('[daemon] ports busy by a daemon')
    return
  }

  const apiPort = parseInt(configApiMa.nodeAddress().port, 10)
  const gatewayPort = parseInt(configGatewayMa.nodeAddress().port, 10)

  const freeGatewayPort = await portfinder.getPortPromise({ port: gatewayPort, stopPort: gatewayPort + 100 })
  const freeApiPort = await portfinder.getPortPromise({ port: apiPort, stopPort: apiPort + 100 })

  const busyApiPort = apiPort !== freeApiPort
  const busyGatewayPort = gatewayPort !== freeGatewayPort

  if (!busyApiPort && !busyGatewayPort) {
    return
  }

  let message = null
  let options = null

  if (busyApiPort && busyGatewayPort) {
    logger.info('[daemon] api and gateway ports busy')
    message = 'busyPortsDialog'
    options = {
      port1: apiPort,
      alt1: freeApiPort,
      port2: gatewayPort,
      alt2: freeGatewayPort
    }
  } else if (busyApiPort) {
    logger.info('[daemon] api port busy')
    message = 'busyPortDialog'
    options = {
      port: apiPort,
      alt: freeApiPort
    }
  } else {
    logger.info('[daemon] gateway port busy')
    message = 'busyPortDialog'
    options = {
      port: gatewayPort,
      alt: freeGatewayPort
    }
  }

  const opt = showDialog({
    title: i18n.t(`${message}.title`),
    message: i18n.t(`${message}.message`, options),
    type: 'error',
    buttons: [
      i18n.t(`${message}.action`, options),
      i18n.t('close')
    ]
  })

  if (opt !== 0) {
    throw new Error('ports already being used')
  }

  if (busyApiPort) {
    config.Addresses.API = config.Addresses.API.replace(apiPort.toString(), freeApiPort.toString())
  }

  if (busyGatewayPort) {
    config.Addresses.Gateway = config.Addresses.Gateway.replace(gatewayPort.toString(), freeGatewayPort.toString())
  }

  writeConfigFile(ipfsd, config)
  logger.info('[daemon] ports updated')
}

module.exports = Object.freeze({
  configPath,
  applyDefaults,
  checkCorsConfig,
  checkPorts
})
