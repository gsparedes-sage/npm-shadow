"use strict";
var Module = require('module').Module;

function log(message) {
	console.log("[NPM-CACHE] ", message)
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
	var cacheRoot = options.cacheRoot || fsp.join(__dirname, '../cached-modules');
	var verbose = !!options.verbose;


	var txtCacheRoot = cacheRoot;
	var redirRoot = fsp.join(cacheRoot, "redir");
	var varCacheRoot = fsp.join(cacheRoot, "$$BIN$$");

	var original = {
		_resolveFilename: Module._resolveFilename,
		_findPath: Module._findPath,
	};

	function under(path, ref) {
		return path.substring(0, ref.length) === ref;
	}

	var packages = {};

	function loadPackage(name) {
		if (packages[name] !== undefined) return packages[name];
		var path = fsp.join(root, 'node_modules', name, 'package.json');
		if (fs.existsSync(path)) return packages[name] = JSON.parse(fs.readFileSync(path, 'utf8'));
		else return packages[name] = null;
	}

	function ensureCacheDir(cacheDir, foundDir) {
		if (fs.existsSync(cacheDir)) return;
		ensureCacheDir(fsp.join(cacheDir, '..'), fsp.join(foundDir, '..'));
		fs.mkdirSync(cacheDir);
		var pkgPath = fsp.join(foundDir, 'package.json');
		if (fs.existsSync(pkgPath)) fs.writeFileSync(fsp.join(cacheDir, 'package.json'), fs.readFileSync(pkgPath));
	}

	Module._resolveFilename = function(request, parent) {
		var redir;
		//console.error("RESOLVE" + request, parent.filename + ': paths=' + parent.paths);
		var from = parent.filename == null ? parent.paths[0] : fsp.dirname(parent.filename);
		if (under(from, root)) {
			var root2 = fsp.join(root, 'node_modules');
			var req = under(request, root2) ? request.substring(root2.length + 1) : request;
			redir = fsp.join(from, req.replace(/[\/\\]/g, '$$'));
			redir = redirRoot + redir.substring(root.length) + '.redir'; // .redir ext to avoid conflict with existing dires
		}
		try {
			var foundPath = original._resolveFilename(request, parent);
			if (redir && under(foundPath, root)) {
				var binary = /\.node$/.test(foundPath) && foundPath.indexOf(arch) < 0;
				var foundRel = foundPath.substring(root.length);
				var comps = foundRel.split(/[\/\\]/);
				if (comps[1] !== 'node_modules') return foundPath;
				var pkg = loadPackage(comps[2]);
				if (!binary && (!pkg || pkg.private)) return foundPath;
				var cachePath = (binary ? varCacheRoot : txtCacheRoot) + foundRel;
				var cached;
				if (fs.existsSync(redir)) {
					cached = JSON.parse(fs.readFileSync(redir, "utf8"));
					if (pkg && cached.version !== pkg.version) cached = null;
				}
				if (!cached) {
					ensureDir(fsp.dirname(redir));
					fs.writeFileSync(redir, JSON.stringify({
						version: pkg && pkg.version,
						path: cachePath.substring(root.length),
					}, null, '\t'), "utf8");
				}
				if (binary) cachePath = cachePath.replace('$$BIN$$', arch + '-' + v8);
				if (!cached || !fs.existsSync(cachePath)) {
					verbose && log("creating " + cachePath);
					ensureCacheDir(fsp.dirname(cachePath), fsp.dirname(foundPath));
					fs.writeFileSync(cachePath, fs.readFileSync(foundPath));
				}
			}
			return foundPath;
		} catch (err) {
			//console.error("ERROR! ", err.stack);
			if (err.code === 'MODULE_NOT_FOUND' && redir && fs.existsSync(redir)) {
				var cached = JSON.parse(fs.readFileSync(redir, "utf8"));
				cachePath = root + cached.path.replace('$$BIN$$', arch + '-' + v8);
				return cachePath;
			} else throw err;
		}
	}
}