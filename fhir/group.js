const crypto = require("crypto");
const moment = require("moment");
const DB     = require("../db");
const config = require("../config");
const lib    = require("../lib");

const SERVER_START_TIME = moment().format("YYYY-MM-DD HH:mm:ss");

function resourceCreator(req, multiplier) {
    return function resource(group) {
        const json = JSON.parse(group.resource_json);
        return {
            fullUrl: lib.getBaseUrl(req) + `/fhir/Group/${json.id}`,
            resource: {
                resourceType: "Group",
                id: json.id,
                identifier: [
                    {
                        system: "https://bulk-data/db-id",
                        value : group.id
                    }
                ],
                quantity: group.quantity * multiplier,
                name: json.name,
                text: {
                    status: "generated",
                    div: `<div xmlns="http://www.w3.org/1999/xhtml">${lib.htmlEncode(json.name)}</div>`
                },
                type: "person",
                actual: true
            }
        };
    }
}

function bundle(req, items, multiplier) {
    const len = items.length;
    const bundle = {
        "resourceType": "Bundle",
        "id"  : crypto.randomBytes(32).toString("hex"),
        "meta": {
            "lastUpdated": SERVER_START_TIME
        },
        "type": "searchset",
        "total": len,
        "link": [
            {
                "relation": "self",
                "url": lib.getBaseUrl(req) + '/fhir/Group'
            }
        ]
    };

    if (len) {
        bundle.entry = items.map(resourceCreator(req, multiplier));
    }

    return bundle;
}

module.exports = (req, res) => {
    const sim = lib.getRequestedParams(req);
    let multiplier = sim.m || 1;
    let stu = sim.stu || 3;

    DB(stu).all(
        `SELECT g.resource_json, g.id, COUNT(*) AS "quantity"
        FROM "data" as "g"
        LEFT JOIN "data" AS "d" ON (d.group_id = g.id)
        WHERE g.fhir_type = "Group"
        AND d.fhir_type = "Patient"
        GROUP BY d.group_id`,
        (error, rows) => {
            if (error) {
                console.error(error);
                return lib.operationOutcome(res, "DB query error");
            }
            res.json(bundle(req, rows, multiplier));
        }
    );
};
