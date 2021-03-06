const _temp = {};
const fs = require('fs');
const Promise = require('bluebird');
const {Router} = require('express');
const crypto = require('crypto');
const route = Router();
const avoidFields = ['salt', 'password'];
const sha512 = function (string, salt) {
    let hash = crypto.createHmac('sha512', salt);
    hash.update(string);
    return hash.digest('hex');
};
const jsonParse = function (string) {
    try {
        throw JSON.parse(string);
    } catch (e) {
        return e
    }
};
const describeColumns = async function (name) {
    let columns = await _temp.compileFn(`DESCRIBE \`${name}\``);
    return columns.map(function (row) {
        return [row.Field, row.Null];
    });
};
const getRelation = async function (name, mode) {
    let up = [], down = [];
    let relation = await _temp.compileFn(`
        SELECT
          IF (TABLE_NAME = '${name}', 0, 1) IS_CHILD,
          TABLE_NAME 'TABLE',
          COLUMN_NAME 'COLUMN',
          REFERENCED_TABLE_NAME TABLE_REF,
          REFERENCED_COLUMN_NAME COLUMN_REF
        FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
        WHERE
          COLUMN_NAME != 'id' AND 
          REFERENCED_TABLE_SCHEMA = '${_temp.database}' AND 
          TABLE_SCHEMA = '${_temp.database}' AND
          (TABLE_NAME = '${name}' OR REFERENCED_TABLE_NAME = '${name}')
        ORDER BY IF (TABLE_NAME = '${name}', 0, 1);
    `);
    relation.forEach(function (row) {
        let o = {
            table: row.TABLE,
            column: row.COLUMN,
            table_ref: row.TABLE_REF,
            column_ref: row.COLUMN_REF
        };
        if (row.IS_CHILD) down.push(o);
        else up.push(o);
    });
    return !mode ? {up, down} : mode === 'up' ? up : down;
};
const getParentRelations = async function (name, alias) {
    let self = await describeColumns(name);
    let parents = await getRelation(name, 'up');
    let mapper = [name].concat(parents);
    let columns = [], joins = [];

    await Promise.map(mapper, async function (relate, i) {
        let join = {};
        let table_name = i ? relate.table_ref : name;
        let cols = await describeColumns(table_name);
        let newAlias = relate.column ? relate.column.substr(0, relate.column.length - relate.column_ref.length - 1) : '';

        if (i) {
            let allowNull = self.filter(function(elm){
                return elm[0] === relate.column ? 1 : 0;
            })[0][1];

            join = {
                target: table_name,
                alias: 'r' + i,
                on: {[relate.column_ref]: `$z.${relate.column}$`}
            };

            if (table_name !== 'op') join.on['op_id'] = {$in: [1, 2]};
            if (table_name === name) join.type = 'left';
            else if (allowNull === 'YES') join.type = 'left';

            joins.push(join);
        }

        cols.forEach(function (elm) {
            let col = elm[0];
            let columnName = [join.alias || alias, col].join('.');
            let asColumn = i ? [newAlias, col].join('_') : join.alias ? columnName : col;
            let isExist = columns.filter(function (col) {
                let avoid = avoidFields.filter(function (field) {
                    if (asColumn.indexOf(field) > -1) return 0;
                    return 1;
                });
                let added = avoid.length === avoidFields.length;
                if ((col.as === asColumn) || !added) return 1;
                return 0;
            });
            if (!isExist.length) {
                columns.push({
                    name: columnName,
                    as: asColumn
                });
            }
        })
    });

    return {columns, joins, parents}
};
const setCondition = function (object, columns) {
    let fn = function (object, columns) {
        if (object instanceof Object || object instanceof Array) {
            for (let key in object) {
                let child = object[key];
                let found = columns.filter(function (obj) {
                    if (obj.as === key) return 1
                    return 0
                });
                if (found.length) {
                    object[found[0].name] = object[key];
                    delete object[key];
                }
                fn(child, columns);
            }
        }
    }
    fn(object, columns);
    return object;
};
const setQuery = async function (object, method, query = {}, body = {}) {
    let filter, sorter, error = [], {table} = object,
        columns = await describeColumns(object.table);

    if (['POST', 'PUT'].indexOf(method) > -1 && !Object.keys(body).length) {
        error.push('body payloads value');
    }
    if (query.hasOwnProperty('filter') && method !== 'POST') {
        filter = jsonParse(query.filter);
        if (!filter) error.push(filter.message);
        if (!Object.keys(filter).length) error.push('query string for filter value');
    }
    if (query.hasOwnProperty('sort') && method === 'GET') {
        sorter = jsonParse(query.sort);
        if (!sorter) error.push(sorter.message);
        if (sorter.length) {
            object.order = {};
            sorter.forEach(function (sort = {}, i) {
                let {property, direction} = sort;
                if (property && direction) {
                    object.order[property] = direction.toLowerCase();
                } else {
                    error.push(`query string for sort value at index-${i} require "property" and "direction" key`);
                }
            });
        }
    }
    if (table === 'person' && (method === 'POST' || method === 'PUT')) {
        let isObject = body.constructor === Object;
        let payloads = isObject ? [body] : body;
        payloads.forEach(function (data, i) {
            if (!data.username) {
                error.push('username in body payload values' + (isObject ? '' : ' at index' + i))
            }
        })
    }
    if (error.length) return new Error(`Invalid ${error.join(',')}`);
    //
    if (method === 'POST') {
        body = body.constructor === Object ? [body] : body;
        object.type = 'insert';
        object.values = body.map(function (row) {
            let data = {};

            columns.forEach(function (elm) {
                let field = elm[0];
                if (row[field]) data[field] = row[field];
            });
            data.op_id = 2;

            return data
        });
        if (table === 'person') {
            object.values.forEach(function (data){
                let salt = _temp.randomString(16);
                Object.assign(data, {
                    salt, password: sha512(data.username, salt)
                });
            });
        }
    } else if (method === 'PUT') {
        object.operations = [];
        body = body.constructor === Object ? [body] : body;
        body.forEach(function (row) {
            let data = {};
            let condition = row._;
            let {id} = condition;

            columns.forEach(function (elm) {
                let field = elm[0];
                if (avoidFields.indexOf(field) < 0) {
                    if (row.hasOwnProperty(field)) {
                        if (((field.slice(-3) === '_id') && !row[field]) || !row[field]) data[field] = null;
                        else data[field] = row[field]
                    }
                }
            });
            data.op_id = 2;

            if (condition.hasOwnProperty('id') && id) {
                object.operations.push({
                    table: table,
                    type: 'update',
                    updates: data,
                    where: {id}
                })
            } else {
                if (table === 'person') {
                    let salt = _temp.randomString(16);
                    Object.assign(data, {
                        salt, password: sha512(data.username, salt)
                    });
                }
                object.operations.push({
                    table: table,
                    type: 'insert',
                    values: data
                })
            }
        });
    } else if (method === 'DELETE') {
        body = body.constructor === Object ? [body] : body;
        object.type = 'update';
        let $in = body.filter(function (o) {
            if (o.id) return 1;
            return 0;
        }).map(function (o) {
            return o.id
        });
        object.updates = {op_id: 3};
        object.where = {id: {$in}, op_id: {$nin: [1, 3]}};
    } else if (method === 'GET') {
        let parents;

        filter = filter || {};
        filter.op_id = {$in: [1, 2]};
        object.alias = 'z';
        object.type = 'select';
        object.offset = parseInt(query.offset) || 0;
        object.limit = parseInt(query.limit) || 100;
        parents = await getParentRelations(table, object.alias);
        object.columns = parents.columns;
        object.joins = parents.joins;
        object.where = setCondition(filter, parents.columns);
        for (let o in object.order) {
            for (let col in parents.columns) {
                let column = parents.columns[col];
                if (column.as === o) {
                    object.order[column.name] = object.order[o];
                    delete object.order[o];
                    break;
                }
            }
        }
    }
    return object
};
//
module.exports = function ({Glob, locals, compile}) {
    const httpCode = require(`${Glob.home}/utils/http.code`);
    const qbuilder = require(`${Glob.home}/utils/query.builder`);
    const randomString = require(`${Glob.home}/utils/random.string`);
    const {name} = locals;
    const authorizing = async function (req, res, next) {
        let {method, query, body} = req,
            {routes} = req.logged,
            {name} = req.params,
            {status, message} = httpCode.OK,
            reqUrl = '/api' + req._parsedUrl.pathname;

        try {
            if (Glob.tables.indexOf(name) === -1) {
                throw new Error(`Invalid route name for ${reqUrl}`);
            }
            if (!routes.hasOwnProperty(reqUrl)) {
                throw new Error(`You can't access ${reqUrl} route`);
            }
            if (routes[reqUrl].methods.indexOf(method) === -1) {
                throw new Error(`You can't access ${reqUrl} route with ${method}'s method`);
            }
            //
            req.queryObj = await setQuery({table: name}, method, query, body);
            if (req.queryObj instanceof Error) throw req.queryObj;
            return next();
        } catch (e) {
            return next(e);
        }
    };
    _temp.database = Glob.config.mysql.database;
    _temp.compileFn = compile;
    _temp.randomString = randomString;
    //
    route.get('/_models', async function (req, res, next) {
        let tables = {};
        let lowerCaseTables = Glob.tables.map(function (table) {
            return table.toLowerCase();
        });
        let {status, message} = httpCode.OK;
        //
        await Promise.map(Glob.tables, async function (name, i) {
            let rawFields = await compile(`DESCRIBE ${name}`);
            let {columns, parents} = await getParentRelations(name, 'o');
            let self = {};
            rawFields.forEach(function (el) {
                self[el.Field] = {
                    type: el.Type,
                    /** Hide useless information **/
                    //null: el.Null,
                    //key: el.Key,
                    //default: el.Default
                }
            });
            parents.forEach(function (relate) {
                let table = Glob.tables[lowerCaseTables.indexOf(relate.table_ref)];
                let prefix = relate.column.substr(0, relate.column.length - relate.column_ref.length - 1);
                self[relate.column].table_ref = table || '?';
                self[relate.column].column_ref = relate.column_ref;
                self[relate.column].relation = table ? 'open' : 'restrict';
                self[relate.column].prefix = prefix !== table ? prefix : table;
            });
            tables[name] = self;
        });
        /** Hide useless information **/
        //for (let name in tables) {
        //    let table = tables[name];
        //    for (let key in table) {
        //        let field = table[key];
        //        if (field.table_ref) {
        //            field.ref = field.table_ref === name ? 'self' : tables[field.table_ref]
        //        }
        //    }
        //}
        res.send({status, message, data: tables})
    });
    route.put('/:name', authorizing, async function (req, res, next) {
        let {status, message} = httpCode.OK;
        let {method, query, body, queryObj} = req;
        let request = {method, body, query, sql: []};

        try {
            let data = await Promise.all(Promise.map(queryObj.operations, function (obj) {
                let sql = qbuilder(obj).raw;
                request.sql.push(sql);
                return compile(sql);
            }));
            res.send({status, message, request, data});
        } catch (e) {
            if (e.message.indexOf('Unexpected token') === 0) {
                let error = 'Invalid query string for filter value, it should be JSON format. ' + e.message;
                next(new Error(error));
            } else next(e);
        }
    });
    route.post('/:name', authorizing, async function (req, res, next) {
        let {status, message} = httpCode.OK;
        let {method, query, body, queryObj} = req;
        let mainQuery = qbuilder(queryObj).raw;
        let request = {method, body, query, sql: mainQuery};

        try {
            let data = await compile(mainQuery);
            res.send({status, message, request, data});
        } catch (e) {
            if (e.message.indexOf('Unexpected token') === 0) {
                let error = 'Invalid query string for filter value, it should be JSON format. ' + e.message;
                next(new Error(error));
            } else next(e);
        }
    });
    route.delete('/:name', authorizing, async function (req, res, next) {
        let {status, message} = httpCode.OK;
        let {method, query, body, queryObj} = req;
        let mainQuery = qbuilder(queryObj).raw;
        let request = {method, body, query, sql: mainQuery};

        try {
            let data = await compile(mainQuery);
            res.send({status, message, request, data});
        } catch (e) {
            if (e.message.indexOf('Unexpected token') === 0) {
                let error = 'Invalid query string for filter value, it should be JSON format. ' + e.message;
                next(new Error(error));
            } else next(e);
        }
    });
    route.get('/:name', authorizing, async function (req, res, next) {
        let {status, message} = httpCode.OK;
        let {method, query, body, queryObj} = req;
        let counter = Object.assign({}, queryObj);

        delete counter.offset;
        delete counter.limit;

        let mainQuery = qbuilder(queryObj).raw;
        let totalQuery = qbuilder({
            type: 'select',
            table: counter,
            alias: 'counter',
            columns: [{type: 'COUNT', expression: '*', as: 'xy'}]
        }).raw;
        let request = {method, body, query, sql: mainQuery};

        //todo: delete next line!
        request.original = qbuilder(queryObj).original;

        try {
            let total = await compile(totalQuery);
            let data = await compile(mainQuery);
            res.send({status, message, request, total: total[0].xy, data});
        } catch (e) {
            if (e.message.indexOf('Unexpected token') === 0) {
                let error = 'Invalid query string for filter value, it should be JSON format. ' + e.message;
                next(new Error(error));
            } else next(e);
        }
    });
    return route;
};