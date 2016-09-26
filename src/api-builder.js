/*global module, require, Promise, console */
var convertApiGWProxyRequest = require('./convert-api-gw-proxy-request'),
	lowercaseKeys = require('./lowercase-keys');
module.exports = function ApiBuilder(options) {
	'use strict';
	var self = this,
		getRequestFormat = function (newFormat) {
			var supportedFormats = ['AWS_PROXY', 'CLAUDIA_API_BUILDER'];
			if (!newFormat) {
				return 'CLAUDIA_API_BUILDER';
			} else {
				if (supportedFormats.indexOf(newFormat) >= 0) {
					return newFormat;
				} else {
					throw 'Unsupported request format ' + newFormat;
				}
			}
		},
		requestFormat = getRequestFormat(options && options.requestFormat),
		methodConfigurations = {},
		routes = {},
		customCorsHandler,
		postDeploySteps = {},
		customCorsHeaders,
		unsupportedEventCallback,
		authorizers,
		v2DeprecationWarning = function (what) {
			console.log(what + ' are deprecated, and be removed in claudia api builder v3. Check https://claudiajs.com/tutorials/migrating_to_2.html');
		},
		supportedMethods = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH'],
		interceptCallback,
		prompter = (options && options.prompter) || require('./ask'),
		isApiResponse = function (obj) {
			return obj && (typeof obj === 'object') && (Object.getPrototypeOf(obj) === self.ApiResponse.prototype);
		},
		mergeObjects = function (from, to) {
			Object.keys(from).forEach(function (key) {
				to[key] = from[key];
			});
			return to;
		},
		isRedirect = function (code) {
			return /3[0-9][0-9]/.test(code);
		},
		getContentType = function (configuration, result) {
			var staticHeader = (configuration && configuration.headers && lowercaseKeys(configuration.headers)['content-type']),
				dynamicHeader = (result && isApiResponse(result) && result.headers && lowercaseKeys(result.headers)['content-type']),
				staticConfig = configuration && configuration.contentType;

			return dynamicHeader || staticHeader || staticConfig || 'application/json';
		},
		getStatusCode = function (configuration, result) {
			var staticCode = (configuration && configuration.code) || (typeof configuration === 'number' && configuration),
				dynamicCode = (result && isApiResponse(result) && result.code);
			return dynamicCode || staticCode || 200;
		},
		getRedirectLocation = function (configuration, result) {
			var dynamicHeader = result && isApiResponse(result) && result.headers && lowercaseKeys(result.headers).location,
				dynamicBody = isApiResponse(result) ? result.response : result,
				staticHeader = configuration && configuration.headers && lowercaseKeys(configuration.headers).location;
			return dynamicHeader || dynamicBody || staticHeader;
		},
		getBody = function (contentType, handlerResult) {
			var contents = isApiResponse(handlerResult) ? handlerResult.response : handlerResult;
			if (contentType === 'application/json') {
				if (contents === '' || contents ===	undefined) {
					return '{}';
				} else {
					return JSON.stringify(contents);
				}
			} else {
				if (!contents) {
					return '';
				} else if (typeof contents === 'object') {
					return JSON.stringify(contents);
				} else {
					return String(contents);
				}
			}
		},
		packResult = function (handlerResult, routingInfo, corsHeaders) {
			var path = routingInfo.path.replace(/^\//, ''),
				method = routingInfo.method,
				successConfiguration = methodConfigurations[path] && methodConfigurations[path][method] && methodConfigurations[path][method].success,
				customHeaders = successConfiguration && successConfiguration.headers,
				contentType = getContentType(successConfiguration, handlerResult),
				statusCode = getStatusCode(successConfiguration, handlerResult),
				result = {
					statusCode: statusCode,
					headers: { 'Content-Type': contentType },
					body: getBody(contentType, handlerResult)
				};
			mergeObjects(corsHeaders, result.headers);
			if (customHeaders) {
				if (Array.isArray(customHeaders)) {
					v2DeprecationWarning('enumerated headers');
				} else {
					mergeObjects(customHeaders, result.headers);
				}
			}
			if (isApiResponse(handlerResult)) {
				mergeObjects(handlerResult.headers, result.headers);
			}
			if (isRedirect(statusCode)) {
				result.headers.Location = getRedirectLocation(successConfiguration, handlerResult);
			}
			return result;
		},
		getCorsHeaders = function (request, methods) {
			return Promise.resolve().then(function () {
				if (customCorsHandler === false) {
					return '';
				} else if (customCorsHandler) {
					return customCorsHandler(request);
				} else {
					return '*';
				}
			}).then(function (corsOrigin) {
				return {
					'Access-Control-Allow-Origin': corsOrigin,
					'Access-Control-Allow-Headers': corsOrigin && (customCorsHeaders || 'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token'),
					'Access-Control-Allow-Methods': corsOrigin && methods.sort().join(',') + ',OPTIONS'
				};
			});
		},
		routeEvent = function (routingInfo, event, context) {
			var handler;
			if (!routingInfo) {
				throw 'routingInfo not set';
			}
			handler = routes[routingInfo.path] && routes[routingInfo.path][routingInfo.method];
			return getCorsHeaders(event, Object.keys(routes[routingInfo.path] || {})).then(function (corsHeaders) {
				if (routingInfo.method === 'OPTIONS') {
					return {
						statusCode: 200,
						body: '',
						headers: corsHeaders
					};
				} else if (handler) {
					return Promise.resolve().then(function () {
						return handler(event, context);
					}).then(function (result) {
						return packResult(result, routingInfo, corsHeaders);
					});
				} else {
					return Promise.reject('no handler for ' + routingInfo.method + ' ' + routingInfo.path);
				}
			});

		},
		getRequestRoutingInfo = function (request) {
			if (requestFormat === 'AWS_PROXY') {
				if (!request.requestContext) {
					return {};
				}
				return {
					path: request.requestContext.resourcePath,
					method: request.requestContext.httpMethod
				};
			} else {
				return request.context || {};
			}
		},
		getRequest = function (event, context) {
			if (requestFormat === 'AWS_PROXY' || requestFormat === 'DEPRECATED') {
				return event;
			} else {
				return convertApiGWProxyRequest(event, context);
			}
		},
		executeInterceptor = function (request, context) {
			if (!interceptCallback) {
				return Promise.resolve(request);
			} else {
				return Promise.resolve().then(function () {
					return interceptCallback(request, context);
				});
			}
		};
	supportedMethods.forEach(function (method) {
		self[method.toLowerCase()] = function (route, handler, options) {
			var pathPart = route.replace(/^\//, ''),
				canonicalRoute = route;
			if (!/^\//.test(canonicalRoute)) {
				canonicalRoute = '/' + route;
			}
			if (!methodConfigurations[pathPart]) {
				methodConfigurations[pathPart] = {} ;
			}
			methodConfigurations[pathPart][method] = (options || {});
			if (!routes[canonicalRoute]) {
				routes[canonicalRoute] = {};
			}
			routes[canonicalRoute][method] = handler;
		};
	});
	self.apiConfig = function () {
		var result = {version: 3, routes: methodConfigurations};
		if (customCorsHandler !== undefined) {
			result.corsHandlers = !!customCorsHandler;
		}
		if (customCorsHeaders) {
			result.corsHeaders = customCorsHeaders;
		}
		if (authorizers) {
			result.authorizers = authorizers;
		}
		return result;
	};
	self.corsOrigin = function (handler) {
		if (!handler) {
			customCorsHandler = false;
		} else {
			if (typeof handler === 'function') {
				customCorsHandler = handler;
			} else {
				customCorsHandler = function () {
					return handler;
				};
			}
		}
	};
	self.corsHeaders = function (headers) {
		if (typeof headers === 'string') {
			customCorsHeaders = headers;
		} else {
			throw 'corsHeaders only accepts strings';
		}
	};
	self.ApiResponse = function (responseBody, responseHeaders, code) {
		this.response = responseBody;
		this.headers = responseHeaders;
		this.code = code;
	};
	self.unsupportedEvent = function (callback) {
		v2DeprecationWarning('.unsupportedEvent handlers');
		unsupportedEventCallback = callback;
	};
	self.intercept = function (callback) {
		interceptCallback = callback;
	};
	self.proxyRouter = function (event, context, callback) {
		var request = getRequest(event, context),
			routingInfo,
			handleError = function (e) {
				context.done(e);
			};
		context.callbackWaitsForEmptyEventLoop = false;
		return executeInterceptor(request, context).then(function (modifiedRequest) {
			if (!modifiedRequest) {
				return context.done(null, null);
			} else {
				routingInfo = getRequestRoutingInfo(modifiedRequest);
				if (routingInfo && routingInfo.path && routingInfo.method) {
					return routeEvent(routingInfo, modifiedRequest, context, callback).then(function (result) {
						context.done(null, result);
					});
				} else {
					if (unsupportedEventCallback) {
						unsupportedEventCallback(event, context, callback);
					} else {
						return Promise.reject('event does not contain routing information');
					}
				}
			}
		}).catch(handleError);

	};
	self.router = function (event, context, callback) {
		requestFormat = 'DEPRECATED';
		event.lambdaContext = context;
		v2DeprecationWarning('.router methods');
		return self.proxyRouter(event, context, callback);
	};
	self.addPostDeployStep = function (name, stepFunction) {
		if (typeof name !== 'string') {
			throw new Error('addPostDeployStep requires a step name as the first argument');
		}
		if (typeof stepFunction !== 'function') {
			throw new Error('addPostDeployStep requires a function as the first argument');
		}
		if (postDeploySteps[name]) {
			throw new Error('Post deploy hook "' + name + '" already exists');
		}
		postDeploySteps[name] = stepFunction;
	};
	self.addPostDeployConfig = function (stageVarName, prompt, configOption) {
		self.addPostDeployStep(stageVarName, function (options, lambdaDetails, utils) {
			var configureDeployment = function (varValue) {
					var result = {
						restApiId: lambdaDetails.apiId,
						stageName: lambdaDetails.alias,
						variables: { }
					};
					result.variables[stageVarName] = varValue;
					return result;
				},
				deployStageVar = function (deployment) {
					return utils.apiGatewayPromise.createDeploymentPromise(deployment).then(function () {
						return deployment.variables[stageVarName];
					});
				},
				getVariable = function () {
					if (typeof options[configOption] === 'string') {
						return utils.Promise.resolve(options[configOption]);
					} else {
						return prompter(prompt, utils.Promise);
					}
				};
			if (options[configOption]) {
				return getVariable()
					.then(configureDeployment)
					.then(deployStageVar);
			}
		});
	};
	self.postDeploy = function (options, lambdaDetails, utils) {
		var steps = Object.keys(postDeploySteps),
			stepResults = {},
			executeStepMapper = function (stepName) {
				return utils.Promise.resolve().then(function () {
					return postDeploySteps[stepName](options, lambdaDetails, utils);
				}).then(function (result) {
					stepResults[stepName] = result;
				});
			};
		if (!steps.length) {
			return utils.Promise.resolve(false);
		}
		return utils.Promise.map(steps, executeStepMapper, {concurrency: 1}).then(function () {
			return stepResults;
		});
	};
	self.registerAuthorizer = function (name, config) {
		if (!name || typeof name !== 'string' || name.length === 0) {
			throw new Error('Authorizer must have a name');
		}
		if (!config || typeof config !== 'object' || Object.keys(config).length === 0) {
			throw new Error('Authorizer ' + name + ' configuration is invalid');
		}
		if (!authorizers) {
			authorizers = {};
		}
		if (authorizers[name]) {
			throw new Error('Authorizer ' + name + ' is already defined');
		}
		authorizers[name] = config;
	};
};
