'use strict';
const fs = require('fs');
const Promise = require('bluebird');
const csv = require('fast-csv');
const Sequelize = require('Sequelize');
const data = [
    {id: 1, name: 'active'},
    {id: 2, name: 'not active'}
];
exports.up = (queryInterface) => {
    return queryInterface.bulkInsert('status', data, {});
};
exports.down = (queryInterface) => {
    let ids = data.map(function (obj) {
        return parseInt(obj.id)
    });
    return queryInterface.bulkDelete('status', {
        [Sequelize.Op.in]: ids
    });
};