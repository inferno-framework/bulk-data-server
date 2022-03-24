const express      = require("express");
const cors         = require("cors");
const Lib          = require("./lib");
const OpDef        = require("./fhir/OperationDefinition/index");
const bulkImporter = require("./import/bulk_data_import_handler");
const ExportManager = require("./ExportManager");


const router = express.Router({ mergeParams: true });

const jsonTypes = [
    "application/json",
    "application/fhir+json",
    "application/json+fhir"
];

// Start helper express middlewares --------------------------------------------
function extractSim(req, res, next) {
    req.sim = Lib.getRequestedParams(req);
    next();
}

/**
 * Simple Express middleware that will require the request to have "accept"
 * header set to "application/fhir+ndjson".
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
function requireFhirJsonAcceptHeader(req, res, next) {
    if (req.headers.accept != "application/fhir+json") {
        return outcomes.requireAcceptFhirJson(res);
    }
    next();
}

/**
 * Simple Express middleware that will require the request to have "prefer"
 * header set to "respond-async".
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
function requireRespondAsyncHeader(req, res, next) {
    if (req.headers.prefer != "respond-async") {
        return outcomes.requirePreferAsync(res);
    }
    next();
}

/**
 * Validates the requestStart parameter
 * @param {Object} req 
 * @param {Object} res 
 * @param {Function} next 
 */
function validateRequestStart(req, res, next) {
    let requestStart = req.sim.requestStart;

    // ensure requestStart param is present
    if (!requestStart) {
        return outcomes.requireRequestStart(res);
    }

    try {
        requestStart = Lib.fhirDateTime(requestStart);
    } catch (ex) {
        return outcomes.invalidRequestStart(req, res);
    }

    // requestStart - ensure valid date/time note that  using try does not
    // prevent moment from warning about an invalid input when it happens for
    // the first time
    try { requestStart = moment(requestStart); } catch (ex) {  }
    if (!requestStart.isValid()) {
        return outcomes.invalidRequestStart(req, res);
    }

    // requestStart - ensure start param is valid moment in time
    if (requestStart.isSameOrAfter(moment())) {
        return outcomes.futureRequestStart(res);
    }

    next();
}

// End helper express middlewares ----------------------------------------------

const JOBS = {};

const supportedFormats = {
    "application/fhir+ndjson" : "ndjson",
    "application/ndjson"      : "ndjson",
    "ndjson"                  : "ndjson",
    "text/csv"                : "csv",
    "csv"                     : "csv"
};

const exportTypes = {
    ndjson: {
        fileExtension: "ndjson",
        contentType  : "application/fhir+ndjson",
        transform    : toNdjson
    },
    csv: {
        fileExtension: "csv",
        contentType  : "text/csv; charset=UTF-8; header=present",
        transform    : toCSV
    }
};

/**
 * Handles the first request of the flow (the one that comes from
 * `/$export` or `/Patient/$export` or `/group/{groupId}/$export`)
 * @param {Object} req 
 * @param {Object} res 
 * @param {Number} groupId 
 */
async function handleRequest(req, res, groupId = null, system=false) {

    // Validate the accept header
    let accept = req.headers.accept;
    if (!accept || accept == "*/*") {
        accept = "application/fhir+ndjson"
    }
    if (accept != "application/fhir+ndjson" &&
        accept != "application/fhir+json") {
        return outcomes.invalidAccept(res, accept);
    }

    let ext = "ndjson";

    // validate the output-format parameter
    let outputFormat = req.query._outputFormat || req.query['output-format']
    if (outputFormat) {
        ext = supportedFormats[outputFormat];
        if (!ext) {
            return outcomes.invalidOutputFormat(res, outputFormat);
        }
    }

    // Validate the "_since" parameter
    if (req.query._since) {
        try {
            Lib.fhirDateTime(req.query._since, true);
        } catch (ex) {
            console.error(ex);
            return outcomes.invalidSinceParameter(res, req.query._since);
        }
    }

    // Validate the _type parameter;
    const requestedTypes = Lib.makeArray(req.query._type || "").map(t => String(t || "").trim()).filter(Boolean);
    const badParam = requestedTypes.find(type => config.availableResources.indexOf(type) == -1);
    if (badParam) {
        return outcomes.invalidResourceType(res, badParam);
    }

    // Now we need to count all the requested resources in the database.
    // This is to avoid situations where we make the clients wait certain
    // amount of time, jut to tell them that there is nothing to download.
    let builder = new QueryBuilder({

        // The _type parameter is used to specify which resource types are part
        // of the focal query – e.g. what kind of resources are returned in the
        // main set. The _type parameter has no impact on which related
        // resources are included) (e.g. practitioner details for clinical
        // resources). In the absence of this parameter, all types are included.
        type : req.query._type,

        // The start date/time means only records since the nominated time. In
        // the absence of the parameter, it means all data ever.
        start: req.query._since,

        // The chosen group ID (if any)
        group: groupId,

        // Pass this flag to indicate if system level resources should be matched
        systemLevel: !!system
    });

    // Prepare the configuration segment of the status URL. Use the current
    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    let args = Object.assign(
        Lib.getRequestedParams(req),
        builder.exportOptions(),
        {
            // unique id of this request flow (used for canceling)
            id: crypto.randomBytes(32).toString("hex"),
            requestStart: Date.now(),
            secure: !!req.headers.authorization,
            outputFormat: ext,
            group: groupId,
            request: proto + "://" + req.headers.host + req.originalUrl
        }
    );

    // Simulate file_generation_failed error if requested
    if (args.err == "file_generation_failed") {
        return outcomes.fileGenerationFailed(res);
    }

    // Prepare the status URL
    let params = base64url.encode(JSON.stringify(args));
    let url = Lib.getRequestUrl(req).split("?").shift().replace(
        /(\/[^/]+)?\/fhir\/.*/,
        `/${params}/fhir/bulkstatus`
    );

    JOBS[args.id] = STATE_STARTED;

    // Instead of generating the response, and then returning it, the server
    // returns a 202 Accepted header, and a Content-Location at which the
    // client can use to access the response.
    // HTTP/1.1 202 Accepted
    res.set("Content-Location", url);
    return outcomes.exportAccepted(res, url);
    
};

function handleSystemLevelExport(req, res) {
    handleRequest(req, res, null, true);
}

/**
 * Data Consumer requests a bulk data export.
 * Returns all data on all patients that the client’s account has access to,
 * since the starting date time provided.
 */
function handlePatient(req, res) {
    handleRequest(req, res);
};

/**
 * Provides access to all data on all patients in the nominated group. The
 * point of this is that applications can request data on a subset of all
 * their patients without needing a new access account provisioned (exactly
 * how the Group resource is created/identified/defined/managed is out of
 * scope for now – the question of whether we need to do sort this out has
 * been referred to ONC for consideration).
 */
function handleGroup(req, res) {
    handleRequest(req, res, +req.params.groupId);
}

function cancelFlow(req, res) {
    if (JOBS[req.sim.id] === STATE_STARTED) {
        JOBS[req.sim.id] = STATE_CANCELED;
        return outcomes.cancelAccepted(res);
    }
    
    if (JOBS[req.sim.id] === STATE_CANCELED) {
        return outcomes.cancelGone(res);
    }

    return outcomes.cancelNotFound(res);
}

async function handleStatus(req, res) {
    
    let sim = req.sim;
    
    if (JOBS[sim.id] === STATE_CANCELED) {
        return outcomes.canceled(res);
    }

    // ensure requestStart param is present
    let requestStart = moment(req.sim.requestStart);

    // check if the user should (continue to) wait
    let generationTime = sim.dur || sim.dur === 0 ? sim.dur : config.defaultWaitTime;
    let endTime = moment(requestStart).add(generationTime, "seconds");
    let now = moment();

    // If waiting - show progress and exit
    if (endTime.isAfter(now, "second")) {
        let diff = (now - requestStart)/1000;
        let pct = Math.round((diff / generationTime) * 100);
        return res.set({
            "X-Progress" : pct + "%",
            "Retry-After": Math.ceil(generationTime - diff)
        }).status(202).end();
    }

    if (JOBS.hasOwnProperty(sim.id)) {
        delete JOBS[sim.id];
    }

    // Get the count multiplier
    let multiplier = parseInt(String(sim.m || "1"), 10);
    if (isNaN(multiplier) || !isFinite(multiplier) || multiplier < 1) {
        multiplier = 1;
    }

    // Validate the _type parameter;
    const requestedTypes = Lib.makeArray(sim.type || "").map(t => String(t || "").trim()).filter(Boolean);
    const badParam = requestedTypes.find(type => config.availableResources.indexOf(type) == -1);
    if (badParam) {
        return outcomes.invalidResourceType(res, badParam);
    }

    // Count all the requested resources in the database.
    let builder = new QueryBuilder(sim);
    let { sql, params } = builder.compileCount("cnt");
    const DB = getDB(+(sim.stu || 3));
    DB.promise("all", sql, params).then(rows => {
        
        // Finally generate those download links
        let len = rows.length;
        let linksArr = []
        let errorArr = []
        let linksLen = 0;
        let params   = Object.assign({}, sim);
        let baseUrl  = Lib.getRequestUrl(req).split("?").shift().replace(/\/[^/]+\/fhir\/.*/, "");
        let page     = sim.page || config.defaultPageSize;
        let bytes    = 0;

        for(let y = 0; y < len; y++ ) { // for each selected resource
            let row = rows[y];
            let n = Math.ceil((row.cnt * multiplier)/page); // how many files for this resource
            for (let i = 0; i < n; i++) { // generate each file path

                if (linksLen > config.maxFiles) {
                    return res.status(413).send("Too many files");
                }

                params.offset = page * i; // overwrite offset
                params.limit  = page;     // overwrite limit

                if ("request" in params) {
                    delete params.request;
                }

                if ("secure" in params) {
                    delete params.request;
                }

                linksLen = linksArr.push({
                    type: row.fhir_type,
                    count: Math.min(page, row.cnt * multiplier - params.offset),
                    url: Lib.buildUrlPath(
                        baseUrl,
                        base64url.encode(JSON.stringify(params)),
                        "/fhir/bulkfiles/",
                        `${i + 1}.${row.fhir_type}.${exportTypes[sim.outputFormat || "ndjson"].fileExtension}`
                    )
                });
            }
        }

        // Now check for resource types that have been requested but not found
        // in our DB
        builder._fhirTypes.forEach(type => {
            if (!linksArr.find(l => l.type === type)) {
                errorArr.push({
                    type : "OperationOutcome",
                    url: Lib.buildUrlPath(
                        baseUrl,
                        base64url.encode(JSON.stringify({
                            ...params,
                            fileError: `No resources found for type "${type}"`
                        })),
                        `/fhir/bulkfiles/${type}.error.ndjson`
                    )
                })
            }
        });

        res.json({

            // a FHIR instant type that indicates the server's time when the
            // query is run. No resources that have a modified data after this
            // instant should be in the response.
            "transactionTime": requestStart,

            // the full url of the original bulk data kick-off request
            "request" : sim.request,

            // boolean value indicating whether downloading the generated files
            // will require an authentication token. Note: This may be false in
            // the case of signed S3 urls or an internal file server within an
            // organization's firewall.
            "requiresAccessToken" : !!sim.secure,

            // array of bulk data file items with one entry for each generated
            // file. Note: If no data is returned from the kick-off request,
            // the server should return an empty array.
            "output" : linksArr,

            // If no errors occurred, the server should return an empty array
            "error": errorArr
        }).end();
    });
};

function handleFileDownload(req, res) {
    const args         = req.sim;
    const accept       = String(req.headers.accept || "");
    const outputFormat = args.outputFormat || "ndjson";

    // Only "application/fhir+ndjson" is supported for accept headers
    // if (accept && accept.indexOf("application/fhir+ndjson") !== 0) {
    //     return outcomes.onlyNDJsonAccept(res);
    // }

    // early exit in case simulated errors
    if (args.err == "file_expired") {
        return outcomes.fileExpired(res);
    }

    const acceptEncoding = req.headers["accept-encoding"] || "";
    const shouldDeflate  = (/\bdeflate\b/.test(acceptEncoding));
    const shouldGzip     = (/\bgzip\b/.test(acceptEncoding));

    // set the response headers
    res.set({
        "Content-Type": exportTypes[outputFormat].contentType,
        "Content-Disposition": "attachment"
    });

    if (args.fileError) {
        return res.status(400).end(JSON.stringify(
            Lib.createOperationOutcome(args.fileError, { httpCode: 400 })
        ));
    }

    if (shouldDeflate) {
        res.set({ "Content-Encoding": "deflate" });
    } else if (shouldGzip) {
        res.set({ "Content-Encoding": "gzip" });
    }

    let input = new fhirStream(req, res);
    
    input.on("error", error => {
        console.error(error);
        return res.status(500).end();
    });

    input.init().then(() => {
        const transform = exportTypes[outputFormat].transform;
        if (transform) {
            input = input.pipe(transform());
        }

        if (shouldDeflate) {
            input = input.pipe(zlib.createDeflate())
        }
        else if (shouldGzip) {
            input = input.pipe(zlib.createGzip())
        }
        input.pipe(res)
    });
}

// =============================================================================
// BulkData Export Endpoints
// =============================================================================

// System Level Export
// Export data from a FHIR server whether or not it is associated with a patient.
// This supports use cases like backing up a server or exporting terminology
// data by restricting the resources returned using the _type parameter.
router.route("/\\$export")
    .post(express.json({ type: jsonTypes }))
    .all(
        extractSim,
        Lib.requireFhirJsonAcceptHeader,
        Lib.requireRespondAsyncHeader,
        Lib.checkAuth,
        ExportManager.createKickOffHandler(true)
    );

// /Patient/$export - Returns all data on all patients
// /$export - does the same on this server because we don't
router.route(["/Patient/\\$export", "/group/:groupId/\\$export"])
    .post(express.json({ type: jsonTypes }))
    .all(
        extractSim,
        Lib.requireFhirJsonAcceptHeader,
        Lib.requireRespondAsyncHeader,
        Lib.checkAuth,
        ExportManager.createKickOffHandler()
    );

// This is the endPoint that should provide progress information
router.get("/bulkstatus/:id", [
    Lib.checkAuth,
    ExportManager.createStatusHandler()
]);

// The actual file downloads 
router.get("/bulkfiles/:file", [
    extractSim,
    Lib.checkAuth,
    ExportManager.createDownloadHandler()
]);

router.delete("/bulkstatus/:id", [
    extractSim,
    Lib.checkAuth,
    ExportManager.createCancelHandler()
]);

// =============================================================================
// BulkData Import Endpoints
// =============================================================================

// Return import progress by task id generated during kick-off request
// and provide time interval for client to wait before checking again
router.get("/import-status/:taskId", bulkImporter.createImportStatusHandler());

// Stop an import that has not completed
router.delete("/import-status/:taskId", bulkImporter.cancelImport);

// Kick-off import
router.post("/\\$import", bulkImporter.createImportKickOffHandler());

// =============================================================================
// FHIR/Other Endpoints
// =============================================================================

// host dummy conformance statement
router.get("/metadata", cors({ origin: true }), extractSim, require("./fhir/metadata"));

// list all the groups with their IDs and the number of patients included
router.get("/Group", cors({ origin: true }), require("./fhir/group"));

router.get("/\\$get-patients", cors({ origin: true }), require("./fhir/patient"));

// $get-resource-counts operation
router.get("/\\$get-resource-counts", cors({ origin: true }), require("./fhir/get-resource-counts"));

// operation definitions
router.use("/OperationDefinition", cors({ origin: true }), OpDef);

// router.get("/files/", Lib.checkAuth, express.static(__dirname + "/attachments"));
router.use('/attachments', cors({ origin: true }), extractSim, Lib.checkAuth, express.static(__dirname + "/attachments"));


module.exports = router;
