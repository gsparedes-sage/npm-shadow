"use strict";
var Module = require('module').Module;

function log(message) {
	console.log("[NPM-SHADOW] ", message)
}

var os = require('os'),
	fs = require('fs'),
	fsp = require('path');

// sanity check: abort if we find several ../node_modules when walking our directory up
// this confuses the lookup because these directories will have priority over shadow-modules
(function() {
	var dir = fsp.join(__dirname, '..'),
		found = false;
	while (true) {
		var d = fsp.join(dir, '..');
		if (d.length >= dir.length) break;
		var dd = fsp.join(d, 'node_modules');
		if (fs.existsSync(dd)) {
			if (found) throw new Error("npm-shadow detected conflict with " + dd + '.\nPlease remove this directory.\nABORTING!');
			found = true;
		}
		dir = d;
	}
})();


var arch = os.platform() + '-' + os.arch();
var v8 = 'v8-' + /[0-9]+\.[0-9]+/.exec(process.versions.v8)[0];

function ensureDir(path) {
	if (fs.existsSync(path)) return;
	ensureDir(fsp.join(path, '..'));
	fs.mkdirSync(path);
}

function rmdir(path) {
	if (!fs.existsSync(path)) return;
	fs.readdirSync(path).forEach(function(name) {
		var p = fsp.join(path, name);
		if (fs.lstatSync(p).isDirectory()) {
			rmdir(p);
		} else {
			fs.unlinkSync(p);
		}
	});
	fs.rmdirSync(path);
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

	// files that we get from NPM have unix style EOL, which disturbs git
	// so we normalize them to windows-style on windows
	function fixEol(str) {
		return str.replace(/\r\n/g, '\n');
	}

	function copyFile(src, dstRoot, enc, exec) {
		var dst = fsp.join(dstRoot, src.substring(root.length));
		ensureDir(fsp.dirname(dst));
		if (enc) fs.writeFileSync(dst, fixEol(fs.readFileSync(src, enc)), enc);
		else fs.writeFileSync(dst, fs.readFileSync(src));
		if (exec) fs.chmodSync(dst, '755');
	}

	function isPrecompiled(path) {
		return /[\/\\](nodetime[\/\\]compiled|fibers[\/\\]bin)[\/\\]/.test(path);
	}

	// npm adds extra info to package.json files so we get different files on windows and osx.
	// we ignore these differences
	function versionChanged(path) {
		var pkg1 = readPackage(path);
		var pkg2 = readPackage(shadowRoot + path.substring(root.length));
		return !pkg1 || !pkg2 || pkg1.version !== pkg2.version;
	}

	function updateShadowModules(path, depth, pkg, hasGit) {
		fs.readdirSync(path).forEach(function(name) {
			// don't recurse into shadow files!
			if (name === 'shadow-modules' || name === '.git') return;
			var sub = fsp.join(path, name)
			var stat = fs.lstatSync(sub);
			if (stat.isDirectory()) {
				if (/^grunt-/.test(name)) {
					log("skipping " + sub);
					return;
				}
				//log("processing " + sub);
				var npkgPath = fsp.join(sub, 'package.json');
				var npkg = pkg;
				var nHasGit = hasGit;
				if (fs.existsSync(npkgPath)) {
					npkg = readPackage(npkgPath);
					nHasGit = fs.existsSync(fsp.join(sub, '.git'));
				}
				var ndepth = depth;
				if (name === 'node_modules') ndepth++;
				updateShadowModules(sub, ndepth, npkg, nHasGit);
			} else if (stat.isFile()) {
				if ((pkg && !pkg.private && !hasGit) || depth >= 2) {
					if (/(\.(json|js|_js|coffee|_coffee)|^coffee)$/.test(name)) {
						if (name !== "package.json" || versionChanged(sub)) copyFile(sub, shadowRoot, "utf8");
					} else if (/\.(mgc|afm|crt|key)$/.test(name)) {
						copyFile(sub, shadowRoot); // binary mode but copied to node_modules
					} else if (/(^phantomjs(\.exe)?$|\.node$)/i.test(name)) {
						if (isPrecompiled(sub)) copyFile(sub, shadowRoot);
						else copyFile(sub, binRoot, null, /^phantomjs$/.test(name));
					}
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
				if (request[0] === '.') {
					// Module implementation has changed in node >= 4.2 and original._resolveFilename 
					// does not find the file any more (don't know exactly why but it may because mod.dirname 
					// does not exist - but joined path exists - in this case).
					var p = fsp.join(fsp.dirname(mod.filename), request);
					//console.error("trying relative binary", p);
					if (fs.existsSync(p + '.node')) return p + '.node';
				}
				//console.error("trying binary from ", mod.filename, mod.paths);
				return original._resolveFilename(request, mod);
			}
		}
	}

	function flatten(path, depth) {
		var max = 0;
		if (!/node_modules$/.test(path)) {
			fs.readdirSync(path).forEach(function(name) {
				var p = fsp.join(path, name);
				var stat = fs.lstatSync(p);
				if (stat.isDirectory()) max = Math.max(max, flatten(p, depth + 1));
			});
		} else {
			var changed = true;
			while (changed) {
				changed = false;
				fs.readdirSync(path).forEach(function(name) {
					var p = fsp.join(path, name);
					var stat = fs.lstatSync(p);
					if (stat.isDirectory()) {
						var sub = fsp.join(p, 'node_modules');
						if (fs.existsSync(sub) && fs.lstatSync(sub).isDirectory()) {
							fs.readdirSync(sub).forEach(function(n) {
								var oldp = fsp.join(sub, n);
								var newp = fsp.join(path, n);
								if (!fs.existsSync(newp)) {
									//console.log(depth + "\tOLD ", oldp);
									//console.log(depth + "\tNEW ", newp);
									fs.renameSync(oldp, newp);
									changed = true;
								}
							});
						} else {
							max = Math.max(max, flatten(p, depth + 1));
						}
					} else {
						max = Math.max(max, path.length + name.length + 1);
					}
				});
			}
			fs.readdirSync(path).forEach(function(name) {
				var p = fsp.join(path, name);
				var stat = fs.lstatSync(p);
				if (stat.isDirectory()) {
					max = Math.max(max, flatten(p, depth + 1));
				}
			});
		}
		return max;
	}

	return {
		run: function() {
			rmdir(fsp.join(shadowRoot, 'node_modules'));
			// clean binaries manually because we also have private ones
			//rmdir(fsp.join(binRoot, 'node_modules'));
			var max = flatten(fsp.join(root, 'node_modules'), 0);
			console.log("max path length: ", max);
			updateShadowModules(root, 0, readPackage(fsp.join(root, 'package.json')), false);
		},
	};
}

if (module === require.main) {
	module.exports().run();
}