const { join, dirname } = require('path')
const url = require('url')
const fs = require('fs')
const $rdf = require('rdflib')
const mkdirp = require('fs-extra').mkdirp
const uuid = require('uuid')
const debug = require('./debug')
const error = require('./http-error')
const stringToStream = require('./utils').stringToStream
const serialize = require('./utils').serialize
const overQuota = require('./utils').overQuota
const getContentType = require('./utils').getContentType
const extend = require('extend')
const rimraf = require('rimraf')
const ldpContainer = require('./ldp-container')
const parse = require('./utils').parse
const fetch = require('node-fetch')
const { promisify } = require('util')
const URI = require('urijs')
const { lock } = require('proper-lockfile')

const RDF_MIME_TYPES = new Set([
  'text/turtle',            // .ttl
  'text/n3',                // .n3
  'text/html',              // RDFa
  'application/xhtml+xml',  // RDFa
  'application/n3',
  'application/nquads',
  'application/n-quads',
  'application/rdf+xml',    // .rdf
  'application/ld+json',    // .jsonld
  'application/x-turtle'
])

class LDP {
  constructor (argv = {}) {
    extend(this, argv)

    // Suffixes
    if (!this.suffixAcl) {
      this.suffixAcl = '.acl'
    }
    if (!this.suffixMeta) {
      this.suffixMeta = '.meta'
    }

    // Error pages folder
    this.errorPages = null
    if (!this.noErrorPages) {
      this.errorPages = argv.errorPages
      if (!this.errorPages) {
        // TODO: For now disable error pages if errorPages parameter is not explicitly passed
        this.noErrorPages = true
      } else if (!this.errorPages.endsWith('/')) {
        this.errorPages += '/'
      }
    }

    if (this.skin !== false) {
      this.skin = true
    }

    if (this.corsProxy && this.corsProxy[ 0 ] !== '/') {
      this.corsProxy = '/' + this.corsProxy
    }

    return this
  }

  async stat (file) {
    return new Promise((resolve, reject) => {
      fs.stat(file, (err, stats) => {
        if (err) return reject(error(err, "Can't read metadata of " + file))
        resolve(stats)
      })
    })
  }

  async readResource (url) {
    let releaseLock
    try {
      const { path } = await this.resourceMapper.mapUrlToFile({ url })
      releaseLock = await lock(path, { retries: 10 })
      return await promisify(fs.readFile)(path, {encoding: 'utf8'})
    } catch (err) {
      throw error(err.status, err.message)
    } finally {
      if (releaseLock) {
        await releaseLock()
      }
    }
  }

  async readContainerMeta (url) {
    if (url[ url.length - 1 ] !== '/') {
      url += '/'
    }
    return this.readResource(url + this.suffixMeta)
  }

  async listContainer (container, reqUri, containerData, hostname) {
    const resourceGraph = $rdf.graph()

    try {
      $rdf.parse(containerData, resourceGraph, reqUri, 'text/turtle')
    } catch (err) {
      debug.handlers('GET -- Error parsing data: ' + err)
      throw error(500, "Can't parse container")
    }

    try {
      // add container stats
      await ldpContainer.addContainerStats(this, reqUri, container, resourceGraph)
      // read directory
      const files = await ldpContainer.readdir(container)
      // iterate through all the files
      await Promise.all(files.map(async file => {
        const { url: fileUri } = await this.resourceMapper.mapFileToUrl(
          { path: join(container, file), hostname })
        return await ldpContainer.addFile(this, resourceGraph, reqUri, fileUri, container, file)
      }))
    } catch (err) {
      throw error(500, "Can't list container")
    }

    // TODO 'text/turtle' is fixed, should be contentType instead
    // This forces one more translation turtle -> desired
    try {
      return await serialize(resourceGraph, reqUri, 'text/turtle')
    } catch (err) {
      debug.handlers('GET -- Error serializing container: ' + err)
      throw error(500, "Can't serialize container")
    }
  }

  async post (host, containerPath, stream, { container, slug, extension }) {
    const ldp = this
    debug.handlers('POST -- On parent: ' + containerPath)
    // prepare slug
    if (slug) {
      slug = decodeURIComponent(slug)
      if (slug.match(/\/|\||:/)) {
        throw error(400, 'The name of new file POSTed may not contain : | or /')
      }
    }
    // Containers should not receive an extension
    if (container) {
      extension = ''
    }
    // TODO: possibly package this in ldp.post
    let resourcePath = await ldp.getAvailablePath(host, containerPath, { slug, extension })
    debug.handlers('POST -- Will create at: ' + resourcePath)
    let originalPath = resourcePath
    if (container) {
      // Create directory by an LDP PUT to the container's .meta resource
      resourcePath = join(originalPath, ldp.suffixMeta)
      if (originalPath && !originalPath.endsWith('/')) {
        originalPath += '/'
      }
    }
    const { url: putUrl, contentType } = await this.resourceMapper.mapFileToUrl(
      { path: this.resourceMapper.rootPath + resourcePath, hostname: host })
    await ldp.put(putUrl, stream, contentType)
    return originalPath
  }

  /**
   * Serializes and writes a graph to the given uri, and returns the original
   * (non-serialized) graph.
   * Usage:
   *
   *   ```
   *   ldp.putGraph('https://localhost:8443/contacts/resource1.ttl', graph)
   *     .then(graph => {
   *       // success
   *     })
   *   ```
   *
   * @param graph {Graph}
   * @param uri {string}
   * @param [contentType] {string}
   *
   * @return {Promise<Graph>}
   */
  async putGraph (graph, uri, contentType) {
    const { path } = url.parse(uri)
    const content = await serialize(graph, uri, contentType)
    let stream = stringToStream(content)
    return await this.put(path, stream, contentType)
  }

  isValidRdf (body, requestUri, contentType) {
    const resourceGraph = $rdf.graph()
    try {
      $rdf.parse(body, resourceGraph, requestUri, contentType)
    } catch (err) {
      debug.ldp('VALIDATE -- Error parsing data: ' + err)
      return false
    }
    return true
  }

  async put (url, stream, contentType) {
    // PUT requests not supported on containers. Use POST instead
    if ((url.url || url).endsWith('/')) {
      throw error(409,
        'PUT not supported on containers, use POST instead')
    }

    // PUT without content type is forbidden
    if (!contentType) {
      throw error(415,
        'PUT request require a valid content type via the Content-Type header')
    }

    // First check if we are above quota
    let isOverQuota
    try {
      isOverQuota = await overQuota(this.resourceMapper.rootPath, this.serverUri)
    } catch (err) {
      throw error(500, 'Error finding user quota')
    }
    if (isOverQuota) {
      throw error(413, 'User has exceeded their storage quota')
    }

    // Second, create the enclosing directory, if necessary
    const { path } = await this.resourceMapper.mapUrlToFile({ url, contentType, createIfNotExists: true })
    const dirName = dirname(path)
    try {
      await promisify(mkdirp)(dirName)
    } catch (err) {
      debug.handlers('PUT -- Error creating directory: ' + err)
      throw error(err,
        'Failed to create the path to the new resource')
    }

    // Directory created, now write the file
    let releaseLock
    try {
      releaseLock = await lock(path, { retries: 10, realpath: false })
      return await new Promise((resolve, reject) => {
        const file = stream.pipe(fs.createWriteStream(path))
        file.on('error', function () {
          reject(error(500, 'Error writing data'))
        })
        file.on('finish', function () {
          debug.handlers('PUT -- Wrote data to: ' + path)
          resolve()
        })
      })
    } finally {
      if (releaseLock) {
        await releaseLock()
      }
    }
  }

  async exists (hostname, path, searchIndex = true) {
    const options = { hostname, path, includeBody: false, searchIndex }
    return await this.get(options, searchIndex)
  }

  /**
   * Remotely loads the graph at a given uri, parses it and and returns it.
   * Usage:
   *
   *   ```
   *   ldp.fetchGraph('https://example.com/contacts/card1.ttl')
   *     .then(graph => {
   *       // const matches = graph.match(...)
   *     })
   *   ```
   *
   * @param uri {string} Fully qualified uri of the request.
   *
   * @param [options] {object} Options hashmap, passed through to fetchGraph
   *
   * @return {Promise<Graph>}
   */
  async fetchGraph (uri, options = {}) {
    const response = await fetch(uri)
    if (!response.ok) {
      const error = new Error(
        `Error fetching ${uri}: ${response.status} ${response.statusText}`
      )
      error.statusCode = response.status || 400
      throw error
    }
    const body = await response.text()

    return parse(body, uri, getContentType(response.headers))
  }

  /**
   * Loads from fs the graph at a given uri, parses it and and returns it.
   * Usage:
   *
   *   ```
   *   ldp.getGraph('https://localhost:8443/contacts/card1.ttl')
   *     .then(graph => {
   *       // let matches = graph.match(...)
   *     })
   *   ```
   *
   * @param uri {string} Fully qualified uri of the request.
   *   Note that the protocol part is needed, to provide a base URI to pass on
   *   to the graph parser.
   * @param [contentType] {string}
   *
   * @return {Promise<Graph>}
   */
  getGraph (uri, contentType) {
    return this.graph(uri, uri, contentType)
  }

  async graph (url, baseUri, contentType) {
    const body = await this.readResource(url)
    if (!contentType) {
      ({ contentType } = await this.resourceMapper.mapUrlToFile({ url }))
    }
    return new Promise((resolve, reject) => {
      const graph = $rdf.graph()
      $rdf.parse(body, graph, baseUri, contentType,
        err => err ? reject(err) : resolve(graph))
    })
  }

  async get (options, searchIndex = true) {
    let path, contentType, stats
    try {
      ({ path, contentType } = await this.resourceMapper.mapUrlToFile({ url: options, searchIndex }))
      stats = await this.stat(path)
    } catch (err) {
      throw error(404, 'Can\'t find file requested: ' + options)
    }

    // Just return, since resource exists
    if (!options.includeBody) {
      return { stream: stats, contentType, container: stats.isDirectory() }
    }

    // Found a container
    if (stats.isDirectory()) {
      const { url: absContainerUri } = await this.resourceMapper
        .mapFileToUrl({ path, hostname: options.hostname })
      const metaFile = await this.readContainerMeta(absContainerUri)
        .catch(() => '') // Default to an empty meta file if it is missing
      let data
      try {
        data = await this.listContainer(path, absContainerUri, metaFile, options.hostname)
      } catch (err) {
        debug.handlers('GET container -- Read error:' + err.message)
        throw err
      }
      const stream = stringToStream(data)
      // TODO 'text/turtle' is fixed, should be contentType instead
      // This forces one more translation turtle -> desired
      return { stream, contentType: 'text/turtle', container: true }
    } else {
      let chunksize, contentRange, start, end
      if (options.range) {
        const total = fs.statSync(path).size
        const parts = options.range.replace(/bytes=/, '').split('-')
        const partialstart = parts[0]
        const partialend = parts[1]
        start = parseInt(partialstart, 10)
        end = partialend ? parseInt(partialend, 10) : total - 1
        chunksize = (end - start) + 1
        contentRange = 'bytes ' + start + '-' + end + '/' + total
      }
      let releaseLock
      try {
        releaseLock = await lock(path, { retries: 10 })
        return await new Promise((resolve, reject) => {
          const stream = fs.createReadStream(path, start && end ? {start, end} : {})
          stream
            .on('error', function (err) {
              debug.handlers(`GET -- error reading ${path}: ${err.message}`)
              return reject(error(err, "Can't read file " + err))
            })
            .on('open', function () {
              debug.handlers(`GET -- Reading ${path}`)
              return resolve({ stream, contentType, container: false, contentRange, chunksize })
            })
        })
      } finally {
        if (releaseLock) {
          await releaseLock()
        }
      }
    }
  }

  async delete (url) {
    // First check if the path points to a valid file
    let path, stats
    try {
      ({ path } = await this.resourceMapper.mapUrlToFile({ url }))
      stats = await this.stat(path)
    } catch (err) {
      throw error(404, "Can't find " + err)
    }

    // If so, delete the directory or file
    if (stats.isDirectory()) {
      return this.deleteContainer(path)
    } else {
      return this.deleteResource(path)
    }
  }

  async deleteContainer (directory) {
    if (directory[ directory.length - 1 ] !== '/') {
      directory += '/'
    }

    // Ensure the container exists
    let list
    try {
      list = await promisify(fs.readdir)(directory)
    } catch (err) {
      throw error(404, 'The container does not exist')
    }

    // Ensure the container is empty (we ignore .meta and .acl)
    if (list.some(file => file !== this.suffixMeta && file !== this.suffixAcl)) {
      throw error(409, 'Container is not empty')
    }

    // Delete the directory recursively
    try {
      await promisify(rimraf)(directory)
    } catch (err) {
      throw error(err, 'Failed to delete the container')
    }
  }

  async deleteResource (path) {
    let releaseLock
    try {
      releaseLock = await lock(path, { retries: 10 })
      return await promisify(fs.unlink)(path)
    } catch (err) {
      debug.container('DELETE -- unlink() error: ' + err)
      throw error(err, 'Failed to delete resource')
    } finally {
      if (releaseLock) {
        await releaseLock()
      }
    }
  }

  getAvailablePath (host, containerURI, { slug = uuid.v1(), extension }) {
    const path = slug + extension
    function ensureNotExists (self, newPath) {
      // Verify whether the new path already exists
      return self.exists(host, newPath).then(
        // If it does, generate another one
        () => ensureNotExists(self, URI.joinPaths(containerURI,
                `${uuid.v1().split('-')[0]}-${path}`).toString()),
        // If not, we found an appropriate path
        () => newPath
      )
    }
    return ensureNotExists(this, URI.joinPaths(containerURI, path).toString())
  }

  getTrustedOrigins (req) {
    let trustedOrigins = [this.resourceMapper.resolveUrl(req.hostname)].concat(this.trustedOrigins)
    if (this.multiuser) {
      trustedOrigins.push(this.serverUri)
    }
    return trustedOrigins
  }

  static mimeTypeIsRdf (mimeType) {
    return RDF_MIME_TYPES.has(mimeType)
  }

  static mimeTypesAsArray () {
    return Array.from(RDF_MIME_TYPES)
  }
}
module.exports = LDP
