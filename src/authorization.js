module.exports = function (compile) {
    return async function (req, res, next) {
        if (!req.logged) return next(new Error('Login required'));

        let {user} = req.logged;
        let roleData = await compile(`
            SELECT 
                a.id actor_id, a.name actor_name, b.module_id,
                c.module_id module_parent, c.name module_name, 
                c.class module_class, c.seq module_seq, c.collapsed module_collapsed,
                c.notes module_notes,
                d.TABLENAME, d.value route, d.httpmethod_id, 
                e.name httpmethod_name, e.code httpmethod_code
            FROM personActor z
            LEFT JOIN actor a ON z.actor_id = a.id AND z.op_id IN (1, 2)
            LEFT JOIN actorModule b ON a.id = b.actor_id AND b.op_id IN (1, 2)
            LEFT JOIN module c ON c.id = b.module_id AND c.op_id IN (1, 2)
            LEFT JOIN moduleRoute d ON d.module_id = c.id AND d.op_id IN (1, 2)
            LEFT JOIN httpmethod e ON e.id = d.httpmethod_id AND e.op_id IN (1, 2)
            WHERE z.person_id = ? AND z.op_id IN (1, 2)
        `, user.id);
        if (roleData instanceof Error) throw roleData;

        let routes = {}, modules = {}, actors = {};
        for (let a in roleData) {
            let role = roleData[a];
            let {
                module_id, module_parent, module_name,
                module_class, module_seq, module_collapsed,
                module_notes
            } = role;

            actors[role.actor_id] = { id: role.actor_id, name: role.actor_name };

            if (role.route) {
                routes[role.route] = routes[role.route] || {value: role.route, table: role.TABLENAME};
                routes[role.route].methods = routes[role.route].methods || [];
                routes[role.route].methods.push(role.httpmethod_code)
            }

            if (module_id) {
                modules[module_id] = modules[module_id] || {
                    id: module_id,
                    parent: module_parent,
                    name: module_name,
                    class: module_class,
                    seq: module_seq,
                    collapsed: module_collapsed,
                    notes: module_notes,
                    tables: []
                };
            }
            if (role.TABLENAME && modules[module_id].tables.indexOf(role.TABLENAME) < 0) {
                modules[module_id].tables.push(role.TABLENAME);
            }
        }
        /** For nested data modules **/
        //for (let b in modules) {
        //    let node = modules[b];
        //    if (node.parent) {
        //        let parent = modules[node.parent];
        //        parent.children = modules[node.parent].children || [];
        //        parent.children.push(node);
        //    }
        //}
        //for (let c in modules) {
        //    if (modules[c].parent) delete modules[c];
        //}
        //modules = Object.keys(modules).map(function (k) {
        //    return modules[k]
        //});
        req.logged.actor = Object.keys(actors).map(function (id) {
            return actors[id]
        });
        req.logged.routes = routes;
        req.logged.modules = modules;
        next();
    }
};