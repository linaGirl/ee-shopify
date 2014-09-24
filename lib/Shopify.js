!function(){
    'use strict';


	var   Class 		    = require('ee-class')
        , EventEmitter      = require('ee-event-emitter')
		, log 			    = require('ee-log')
        , type              = require('ee-types')
        , argv              = require('ee-argv')
        , request           = require('request')
        , url               = require('url')
        , crypto            = require('crypto')
        , http              = require('http')
        , debug             = argv.has('debug-shopify');




	module.exports = new Class({
        inherits: EventEmitter

        // the shop name of the shop working on
        , shop: null

        // may waiting time for requests in ms
        , ttl: 10000

        // the access token
        , token: null

        // api key & secret
        , credentials: {
              key    : null
            , secret : null
        }

        // scope
        , scope: []

        // shopify domain
        , _shopifyhost: 'myshopify.com'

        // the protocol to use to contact shopify
        , _protocol: 'https://'

        // valid request methods
        , _validMethods: ['get', 'post', 'put'] 

        // url prefix
        , _urlPrefix: '/admin'



        /*
         * Shopify constructor function
         *
         * @param «Object» object containing the shops identifier «shop» and the apps api key «apiKey» or the apps auth token «token»
         */
		, init: function(options) {
            if (!options) throw new Error('You have to provide an options object to the shopifys constructor function!');
            if (!type.string(options.shop) || !options.shop.trim()) throw new Error('You have to provide a shop property to the shopifies constructor function!');

            // the shop identifier
            this.shop = options.shop;

            // the shopify access token, if present
            if (type.string(options.token) && options.token.trim()) {
                this.token = options.token;
                if (debug) log.info('got shopify auth token via contructor «%s» ...', options.token);
            }
            else if (type.string(options.key) && options.key.trim() && type.string(options.secret) && options.secret.trim()) {
                this.credentials.key = options.key;
                this.credentials.secret = options.secret;
                if (debug) log.info('got shopify api key & secret via contructor «%s», %s ...', options.key, options.secret);
            }
            else throw new Error('You have to provide aither the api key or the auth token to the shopifies constructor function!');
		}


        /*
         * create the auth url used to connect a shop
         *
         * @param <Mixed> array or string containg the requested scope
         * @param <String> redirect URL
         * 
         */
        , getAuthURL: function(scope, redirectURL) {
            if (!type.array(scope) && (!type.string(scope) || !scope.trim())) throw new Error('You have to provide the apps scope as parameter 1 to the getAuthURL method!');
            if (!type.string(redirectURL) || !redirectURL.trim()) throw new Error('You have to provide the redirect URL as parameter 2 to the getAuthURL method!');

            return url.format({
                  protocol          : this._protocol
                , host              : this._shopifyhost
                , pathname          : '/admin/oauth/authorize'
                , query: {
                      client_id     : this.credentials.key
                    , scope         : type.array(scope) ? scope.join('') : scope 
                    , redirect_uri  : redirectURL
                }
            });
        }



        /*
         * exchange code received from the shopify api with the api token, stores it ok this instance
         *
         * @param <Mixed> request query parameters or url containg parameters or request object
         * @param <Function> callback
         * 
         */
        , getToken: function(query, callback) {

            // request
            else if (query instanceof http.IncomingMessage) {
                query = url.parse(query.url).query;

                if (type.object(query) && query.code) query = query.code;
                else return callback(new Error('Failed to get code from request!'));
            }

            // custom request
            else if (type.object(query) && type.object(query.query) && query.query.code) query = query.query.code;

            // not valid
            if (!type.string(query)) return callback(new Error('Failed to get code'));


            // check signature
            if (this.isInvalidQuerySignature(query)) return callback(new Error('Invalid sginature!'));
            else {

                // request the token
                this.request('post', '/oauth/access_token', {
                      client_id         : this.shop
                    , client_secret     : this.credentials.secret
                    , code              : query
                }, function(err, data, response) {
                    if (err) callback(err);
                    else if (!type.object(data) || !type.string(data.access_token)) callback('Request failed, no token was returned!');
                    else {
                        this.token = data.access_token;
                        callback(undefined, this.token);
                    }
                }.bind(this));
            }
        }





        /*
         * check the signature of the request query
         *
         * @param <Mixed> request query parameters, request or url containg parameters
         * 
         * @returns <Mixed> Error, True, or False
         */
        , isInvalidQuerySignature: function(query) {
            var signature;

            // url or querystring
            if (type.string(query)) query = url.parse(query).query;

            // node http request
            else if (type.object(query) && query instanceof http.IncomingMessage) query = url.parse(query).query;

            // custom request implementation
            else if (type.object(query) && type.object(query.query)) query = query.query;


            // need an objects
            if (!type.object(query)) return new Error('Invalid signature! Missing signature & data!');


            // check signature
            return !(crypto.createHash('md5').update(Object.keys(query).sort().map(function(key) {
                if (key.trim().toLowerCase() === 'signature') {
                    signature = query[key];
                    return '';
                }
                else return key+'='+query[key];
            }).join('')).digest('hex') === signature && signature);
        }




        /*
         * check the signature of the request body
         *
         * @param <Mixed> request or request headers or signature header
         * @param <Mixed> payload, buffer or string
         *
         * @returns <Mixed> Error, True, or False
         *
         */
        , isInvalidBodySignature: function(header, data) {
            var signature;

            // header an data pair
            if (type.string(header) || header instanceof http.IncomingMessage) {
                if (type.object(header)) signature = header.headers['X-Shopify-Hmac-SHA256'];
                else signature = header;
            }

            // custom request implementation
            else if (type.object(header) && type.object(header.headers)) signature = header.headers['X-Shopify-Hmac-SHA256'];

            // another ttype of custom requests
            else if (type.object(header) && type.function(header.getHeader)) signature = header.getHeader('X-Shopify-Hmac-SHA256');



            // check if we got the signature header
            if (!signature) return new Error('Invalid signature! Missing signature header!');


            // check for payload
            if (type.string(data)) data = new Buffer(data);
            else if (!type.buffer(data)) return new Error('Invalid signature! Missing payload data!');


            if (!this.credentials.secret) return new Error('Cannot validate the signature, secret is missing (provide it in the sgopify constructor function)!');

            // check signature
            return !(signature === crypto.createHmac('sha256', this.credentials.secret).update(data).digest('base64'));
        }





        /*
         * request a resource from the shopify API
         * 
         * @param <String>      http method (get, put, post)
         * @param <String>      pathname
         * @param <Mixed>       body data: object, string or buffer, either the query
         *                      (get requests) or the request body, or callback
         * @param <function>    callback
         *
         */
        , request: function(method, pathName, data, callback) {
            var   body
                , query;

            if (!type.string(method) || !method.trim()) throw new Error('You have to provide the method as parameter 1 to the request method!');
            if (this._validMethods.indexOf(method.toLowerCase().trim()) === -1) throw new Error('Invalid request method «'+method+'». You have to provide the method ('+this._validMethods.join(', ')+') as parameter 1 to the request method!');
            if (!type.string(pathName) || !pathName.trim()) throw new Error('You have to provide the pathName as parameter 2 to the request method!');
            
            method = method.toLowerCase().trim();
            if (type.function(data)) callback = data, data = undefined;

            if (method === 'get') {
                if (!type.object(data) && !type.string(data) && !type.null(data) && !type.undefined(data)) throw new Error('You have to provide the query (parameter 3) as type undefined, null, object, string! You provided type '+type(data)+'!');
                query = data;
            }
            else {
                if (!type.object(data) && !type.string(data) && !type.buffer(data) && !type.null(data) && !type.undefined(data)) throw new Error('You have to provide the request body (parameter 3) as type undefined, null, object, string or buffer! You provided type '+type(data)+'!');
                body = data;
            }

            // fire request
            request({
                  method            : method
                , headers: {
                    accept          : 'application/json'
                }
                , url: url.format({
                      protocol      : this._protocol
                    , host          : this._shopifyhost
                    , pathname      : pathName.toLowerCase().trim().substr(0, 7) === '/admin/' ? pathName : (this._urlPrefix+(pathName[0] === '/' ? '' : '/' )+pathName)
                    , query         : query
                })
                , body              : body
            }, function(err, response, body) {
                var   responseData
                    , keys;

                if (err) callback(err, undefined, response);
                else {
                    if (response.statusCode === 200 || response.statusCode === 201 || response.statusCode === 204) {

                        // process only if there is abody
                        if (type.string(body) && body.trim()) {
                            // try to parse the response
                            try {
                                responseData = JSON.parse(body.trim());
                            } catch(e) {
                                err = e;
                            }

                            // if we cannot parse the data, abort
                            if (err) callback(err, undefined, response);
                            else {
                                // is there any data at all?
                                if (type.object(responseData)) {
                                    keys = Object.keys(responseData);

                                    // remove the envelope if there is only one key in it
                                    if (key.length === 1) callback(null, responseData[keys[0]]);
                                    else callback(null, responseData, response);
                                }
                                else callback(undefined, undefined, response);
                            }
                        }
                        else callback(undefined, undefined, response);
                    }
                    else {
                        // treat everything as error
                        err             = new Error(body);
                        err.statusCode  = response.statusCode;
                        err.status      = http.STATUS_CODES[response.statusCode];
                        callback(err, undefined, response);
                    }
                }
            }.bind(this));
        }
	});
}();