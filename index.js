const express        = require("express");
const http           = require("http");
const bodyParser     = require("body-parser");
const morgan         = require("morgan");
const cors           = require("cors");
const config         = require("./config");
const generator      = require("./generator");
const tokenHandler   = require("./token_handler");
const register       = require("./registration_handler");
const bulkData       = require("./bulk_data_handler");
const env            = require("./env");
const encodedOutcome = require("./outcome_handler");


const app = express();
const router = express.Router();

/* istanbul ignore if */
if (process.env.NODE_ENV != "test") {
    router.use(morgan("combined"));
}

// HTTP to HTTPS redirect (this is Heroku-specific!)
/* istanbul ignore next */
/*router.use((req, res, next) => {
    let proto = req.headers["x-forwarded-proto"];
    let host  = req.headers.host;
    if (proto && (`${proto}://${host}` !== config.baseUrl)) { 
        return res.redirect(301, config.baseUrl + req.url);
    }
    console.log("Hitting this part!");
    next();
});*/

// backend services authorization
router.options("/auth/token", cors({ origin: true }));
router.post("/auth/token", cors({ origin: true }), bodyParser.urlencoded({ extended: false }), tokenHandler);

// backend services registration
router.post("/auth/register", bodyParser.urlencoded({ extended: false }), register);

// Used as JWKS generator
router.use("/generator", generator);

// host env vars for the client-side
router.get("/env.js", env);

// Send some of the server config vars to the client
router.get("/server-config.js", (req, res) => {
    res.type("javascript").send(
    `var CFG = {
    defaultPageSize: ${config.defaultPageSize},
    defaultWaitTime: ${config.defaultWaitTime},
    defaultTokenLifeTime: ${config.defaultTokenLifeTime}\n};`);
});

// bulk data implementation
router.use(["/:sim/fhir", "/fhir"], bulkData);

// Generic operation outcomes
app.use("/outcome", encodedOutcome);

// static files
router.use(express.static("static"));

// global error handler
/* istanbul ignore next */
router.use(function (err, req, res, next) {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});

// If invoked directly start a server (otherwise let the tests do that)
/* istanbul ignore if */
// @ts-ignore
if (!module.parent) {
    app.use("/bulk-data-server", router);

    app.enable('trust proxy');

    app.listen(config.port, function() {
        console.log("Server listening at " + config.baseUrl);
    });


}

// Make it easier to kill the process when being run through Docker
process.on('SIGINT', function() {
    process.exit();
});
process.on('SIGTERM', function() {
    process.exit();
});

module.exports = {
    app,
    server: http.createServer(app)
};

