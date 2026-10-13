// The platform SDK is unavailable in local tests. This double implements the
// schema and query-builder subset used by `tgcloud/`, compiling statements to
// SQLite SQL and throwing for unsupported APIs. `table()` flattens columns onto
// its descriptor, so `tableName` stores the SQL table name.

const COLUMN_MODES = new Set(["timestamp_ms"]);

const isColumn = (value) => Boolean(value?.__column);
const isFragment = (value) => Boolean(value?.__sql);

function column(name, type, options = {}) {
  const { mode } = options;
  if (mode !== undefined && !COLUMN_MODES.has(mode)) {
    throw new Error(`The local sdk/db double does not implement the "${mode}" column mode.`);
  }
  const definition = {
    __column: true,
    name,
    type,
    constraints: [],
    ...(mode === undefined ? {} : { mode }),
    primaryKey({ autoIncrement = false } = {}) {
      definition.constraints.push(`PRIMARY KEY${autoIncrement ? " AUTOINCREMENT" : ""}`);
      return definition;
    },
    notNull() {
      definition.constraints.push("NOT NULL");
      return definition;
    },
    unique() {
      definition.constraints.push("UNIQUE");
      return definition;
    },
  };
  return definition;
}

export const integer = (name, options) => column(name, "INTEGER", options);
export const text = (name, options) => column(name, "TEXT", options);

export const index = (name) => ({
  __index: true,
  name,
  on: (...targets) => ({ __index: true, name, targets }),
});

export function table(name, columns, declareConstraints) {
  for (const definition of Object.values(columns)) {
    if (!isColumn(definition)) throw new Error(`Table ${name} received a non-column declaration.`);
    definition.table = name;
  }
  const descriptor = { ...columns, columns, tableName: name, __table: true };
  const constraints = declareConstraints ? declareConstraints(descriptor) : {};
  if (constraints === null || typeof constraints !== "object") {
    throw new Error(`Table ${name} must declare its constraints as an object.`);
  }
  descriptor.constraints = constraints;
  return descriptor;
}

function fragment(nodes) {
  return { __sql: true, nodes };
}

function node(value) {
  if (isColumn(value)) return { column: value };
  if (isFragment(value)) return { nodes: value.nodes };
  return { value };
}

function nodesOf(value) {
  if (!isFragment(value)) {
    throw new TypeError("Expected a sql`` fragment or a condition built with eq/and/isNull.");
  }
  return value.nodes;
}

export function sql(pieces, ...values) {
  const nodes = [];
  pieces.forEach((piece, position) => {
    if (piece) nodes.push({ text: piece });
    if (position < values.length) {
      const value = values[position];
      nodes.push(isColumn(value) ? { text: quote(value.name) } : node(value));
    }
  });
  return fragment(nodes);
}

export const eq = (subject, value) => fragment([node(subject), { text: " = " }, node(value)]);

export const isNull = (subject) => fragment([node(subject), { text: " IS NULL" }]);

export const and = (...conditions) => fragment(conditions.flatMap((condition, position) => [
  ...(position === 0 ? [] : [{ text: " AND " }]),
  ...nodesOf(condition),
]));

const quote = (identifier) => `"${identifier}"`;

function encode(value) {
  return value instanceof Date ? value.getTime() : value;
}

function decode(value, definition) {
  return definition?.mode === "timestamp_ms" && value !== null ? new Date(value) : value;
}

function compile(nodes, parameters) {
  return nodes.map((entry) => {
    if (entry.text !== undefined) return entry.text;
    if (entry.column) return `${quote(entry.column.table)}.${quote(entry.column.name)}`;
    if (entry.nodes) return compile(entry.nodes, parameters);
    const name = `p${Object.keys(parameters).length + 1}`;
    parameters[name] = encode(entry.value);
    return `:${name}`;
  }).join("");
}

function decodeRow(row, projection) {
  if (!projection) return row;
  return Object.fromEntries(Object.entries(row)
    .map(([key, value]) => [key, decode(value, projection[key])]));
}

const decodeRows = (rows, projection) => rows.map((row) => decodeRow(row, projection));

export function createDb(driver) {
  if (typeof driver?.run !== "function" || typeof driver?.get !== "function") {
    throw new TypeError("The local sdk/db double needs a driver with run() and get().");
  }

  const columnName = (descriptor, key) => {
    const definition = descriptor.columns[key];
    if (!definition) throw new Error(`Table ${descriptor.tableName} has no column exported as ${key}.`);
    return definition.name;
  };

  const assignments = (descriptor, values, parameters) => Object.entries(values)
    .map(([key, value]) => `${quote(columnName(descriptor, key))} = ${compile([node(value)], parameters)}`)
    .join(", ");

  const projectionKeys = (projection, parameters) => Object.entries(projection)
    .map(([key, value]) => (
      `${isColumn(value) ? quote(value.name) : compile([node(value)], parameters)} AS ${quote(key)}`
    ))
    .join(", ");

  function insert(descriptor) {
    return {
      values(values) {
        const execute = (conflict, projection) => {
          const parameters = {};
          const keys = Object.keys(values);
          let query = `INSERT INTO ${quote(descriptor.tableName)}`
            + ` (${keys.map((key) => quote(columnName(descriptor, key))).join(", ")})`
            + ` VALUES (${keys.map((key) => compile([node(values[key])], parameters)).join(", ")})`;
          if (conflict) {
            const targets = [conflict.target].flat();
            query += ` ON CONFLICT(${targets.map((target) => quote(target.name)).join(", ")})`
              + ` DO UPDATE SET ${assignments(descriptor, conflict.set, parameters)}`;
          }
          if (projection) query += ` RETURNING ${projectionKeys(projection, parameters)}`;
          return driver.run(query, parameters).then((result) => (
            projection ? decodeRows(result.rows ?? [], projection) : result
          ));
        };
        const pending = (conflict) => ({
          returning: (projection) => execute(conflict, projection),
          then: (onFulfilled, onRejected) => execute(conflict, null).then(onFulfilled, onRejected),
        });
        return { onConflictDoUpdate: pending, ...pending(null) };
      },
    };
  }

  function update(descriptor) {
    return {
      set(values) {
        return {
          where(condition) {
            const parameters = {};
            const query = `UPDATE ${quote(descriptor.tableName)} SET ${assignments(descriptor, values, parameters)}`
              + ` WHERE ${compile(nodesOf(condition), parameters)}`;
            return driver.run(query, parameters);
          },
        };
      },
    };
  }

  function select(projection) {
    return {
      from(descriptor) {
        const build = (condition) => {
          const get = async () => {
            const parameters = {};
            const selected = projection === undefined
              ? "*"
              : projectionKeys(projection, parameters);
            const query = `SELECT ${selected} FROM ${quote(descriptor.tableName)}`
              + (condition ? ` WHERE ${compile(nodesOf(condition), parameters)}` : "");
            const row = await driver.get(query, parameters);
            return row ? decodeRow(row, projection) : null;
          };
          return { get };
        };
        return { ...build(null), where: (condition) => build(condition) };
      },
    };
  }

  return {
    run(statement, parameters) {
      if (typeof statement === "string") return driver.run(statement, parameters);
      const compiled = {};
      return driver.run(compile(nodesOf(statement), compiled), compiled);
    },
    select,
    insert,
    update,
  };
}

export const sdkDb = { table, integer, text, index, sql, eq, isNull, and };

export function schemaDdl(schema) {
  const statements = [];
  for (const descriptor of Object.values(schema)) {
    if (descriptor?.__table !== true) throw new Error("A schema module may only export tables.");
    const columns = Object.values(descriptor.columns).map((definition) => (
      `${quote(definition.name)} ${definition.type}`
      + (definition.constraints.length ? ` ${definition.constraints.join(" ")}` : "")
    ));
    statements.push(`CREATE TABLE ${quote(descriptor.tableName)} (${columns.join(", ")})`);
    for (const constraint of Object.values(descriptor.constraints)) {
      if (constraint?.__index !== true) {
        throw new Error(`The local sdk/db double cannot create this ${descriptor.tableName} constraint.`);
      }
      statements.push(`CREATE INDEX ${quote(constraint.name)} ON ${quote(descriptor.tableName)}`
        + ` (${constraint.targets.map((target) => quote(target.name)).join(", ")})`);
    }
  }
  return statements;
}
