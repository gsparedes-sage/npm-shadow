"use strict";
var Module = require('module').Module;

function log(message) {
	console.log("[NPM-SHADOW] ", message)
}

var os = require('os'),
	fs = require('fs'),
	fsp = require('path');

var arch = os.platform() + '-' + os.arch();
var v8 = 'v8-' + /[0-9]+\.[0-9]+/.exec(process.versions.v8)[0];

function ensureDir(path) {
	if (fs.existsSync(path)) return;
	ensureDir(fsp.join(path, '..'));
	fs.mkdirSync(path);
}

module.exports = function(options) {
	options = options || {};
	var root = options.sourceRoot || fsp.join(__dirname, '../..');
	var shadowRoot = options.shadowRoot || fsp.join(__dirname, '../../shadow-modules');
	var binRoot = fsp.join(shadowRoot, arch + '-' + v8);
	var verbose = !!options.verbose;

	function readPackage(path) {
		try {
			return JSON.parse(fs.readFileSync(path, 'utf8'));
		} catch (err) {
			//console.error("bad package.json: " + path + ", err=" + err.message);
		}
	}

	function copyFile(src, dstRoot, enc) {
		var dst = fsp.join(dstRoot, src.substring(root.length));
		ensureDir(fsp.dirname(dst));
		if (false && enc) fs.writeFileSync(dst, fs.readFileSync(src, enc).replace(/\r\n/g, '\n'), enc);
		else fs.writeFileSync(dst, fs.readFileSync(src));
	}

	function updateShadowModules(path, depth, pkg) {
		fs.readdirSync(path).forEach(function(name) {
			// don't recurse into shadow files!
			if (name === 'shadow-modules') return;
			var sub = fsp.join(path, name)
			var stat = fs.lstatSync(sub);
			if (stat.isDirectory()) {
				if (/^grunt-/.test(name)) {
					log("skipping " + sub);
					return;
				}
				log("processing " + sub);
				var npkgPath = fsp.join(sub, 'package.json');
				var npkg = pkg;
				if (fs.existsSync(npkgPath)) npkg = readPackage(npkgPath);
				var ndepth = depth;
				if (name === 'node_modules') ndepth++;
				updateShadowModules(sub, ndepth, npkg);
			} else if (stat.isFile()) {
				if ((pkg && !pkg.private) || depth >= 2) {
					if (/\.(json|js|_js|coffee|_coffee)$/.test(name)) copyFile(sub, shadowRoot, "utf8");
					else if (/\.node$/.test(name)) {
						// if already in arch subdir (fibers precompiled for ex), copy it to regular output dir
						if (sub.indexOf(arch) >= 0) copyFile(sub, shadowRoot);
						else copyFile(sub, binRoot);
					}
				} else {
					if (/\/fibers/.test(sub)) console.error("IGNORING " + sub, pkg && pkg.private, depth)
				}
			}
		});
	}

	function under(path, ref) {
		return path.substring(0, ref.length) === ref;
	}

	var original = {
		_resolveFilename: Module._resolveFilename,
	};

	function shadowPaths(parent, root, relative) {
		var paths = [];
		if (relative) return paths;
		root = fsp.join(root, 'node_modules');
		parent = fsp.join(parent, '../node_modules');
		while (parent.length >= root.length) {
			paths.push(parent);
			parent = fsp.join(parent, '../../node_modules');
		}
		return paths;
	}

	Module._resolveFilename = function(request, parent) {
		try {
			return original._resolveFilename(request, parent);
		} catch (err) {
			if (err.code !== 'MODULE_NOT_FOUND') throw err;
			//console.error("RESOLVE " + request);
			var from = parent.filename == null ? parent.paths[0] : parent.filename;
			if (!under(from, root)) throw err;
			var mod = new Module(parent.id);
			if (under(from, shadowRoot)) mod.filename = from;
			else mod.filename = fsp.join(shadowRoot, from.substring(root.length));
			mod.paths = shadowPaths(mod.filename, shadowRoot, request[0] === '.');
			//console.error("trying from ", mod.filename);
			try {
				return original._resolveFilename(request, mod);
			} catch (err) {
				if (err.code !== 'MODULE_NOT_FOUND') throw err;
				if (under(from, binRoot)) mod.filename = from;
				else if (under(from, shadowRoot)) mod.filename = fsp.join(binRoot, from.substring(shadowRoot.length));
				else mod.filename = fsp.join(binRoot, from.substring(root.length));
				mod.paths = shadowPaths(mod.filename, binRoot, request[0] === '.');
				//console.error("trying binary from ", mod.filename, mod.paths);
				if (!/\.node$/.test(request)) request += '.node';
				return original._resolveFilename(request, mod);
			}
		}
	}
	return {
		run: function() {
			updateShadowModules(root, 0, readPackage(fsp.join(root, 'package.json')));
		},
	};
}

if (module === require.main) {
	module.exports().run();
}