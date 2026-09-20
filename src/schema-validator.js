const MAX_DEPTH = 64;

export function validateJsonSchema(value, schema) {
  try {
    return validate(value, schema, schema, '$', 0);
  } catch (error) {
    return { valid: false, error: error?.message || 'Invalid JSON Schema' };
  }
}

export function assertJsonSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('Tool parameters must be a JSON Schema object');
  }
  // Resolve all local refs once so invalid pointers fail at request-validation time.
  walkSchema(schema, schema, 0, new Set());
  return schema;
}

function walkSchema(node, root, depth, seen) {
  if (depth > MAX_DEPTH) throw new Error('JSON Schema nesting is too deep');
  if (node === true || node === false) return;
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  if (seen.has(node)) return;
  seen.add(node);
  if (typeof node.$ref === 'string') resolveRef(root, node.$ref);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) walkSchema(item, root, depth + 1, seen);
    } else if (value && typeof value === 'object') {
      walkSchema(value, root, depth + 1, seen);
    }
  }
}

function validate(value, schema, root, path, depth) {
  if (depth > MAX_DEPTH) return fail(`${path} exceeded validation depth`);
  if (schema === true) return ok();
  if (schema === false) return fail(`${path} is not allowed by schema`);
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return ok();

  if (typeof schema.$ref === 'string') {
    const resolved = resolveRef(root, schema.$ref);
    const referenced = validate(value, resolved, root, path, depth + 1);
    if (!referenced.valid) return referenced;
  }

  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    return fail(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(item, value))) {
    return fail(`${path} must be one of ${JSON.stringify(schema.enum)}`);
  }

  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) {
      const result = validate(value, part, root, path, depth + 1);
      if (!result.valid) return result;
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const results = schema.anyOf.map((part) => validate(value, part, root, path, depth + 1));
    if (!results.some((result) => result.valid)) return fail(`${path} must match at least one anyOf schema`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.reduce((count, part) => count + (validate(value, part, root, path, depth + 1).valid ? 1 : 0), 0);
    if (matches !== 1) return fail(`${path} must match exactly one oneOf schema`);
  }
  if (schema.not !== undefined && validate(value, schema.not, root, path, depth + 1).valid) {
    return fail(`${path} matches a disallowed schema`);
  }
  if (schema.if !== undefined) {
    const condition = validate(value, schema.if, root, path, depth + 1).valid;
    if (condition && schema.then !== undefined) {
      const result = validate(value, schema.then, root, path, depth + 1);
      if (!result.valid) return result;
    }
    if (!condition && schema.else !== undefined) {
      const result = validate(value, schema.else, root, path, depth + 1);
      if (!result.valid) return result;
    }
  }

  if (schema.nullable === true && value === null) return ok();
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => checkType(value, type))) {
      return fail(`${path} must be of type ${types.join(' or ')}, got ${actualType(value)}`);
    }
  }

  if (value === null) return ok();

  if (typeof value === 'string') {
    const length = [...value].length;
    if (Number.isInteger(schema.minLength) && length < schema.minLength) return fail(`${path} length ${length} is less than minLength ${schema.minLength}`);
    if (Number.isInteger(schema.maxLength) && length > schema.maxLength) return fail(`${path} length ${length} is greater than maxLength ${schema.maxLength}`);
    if (typeof schema.pattern === 'string') {
      let regex;
      try { regex = new RegExp(schema.pattern, schema.patternFlags || 'u'); }
      catch { return fail(`${path} has invalid schema pattern`); }
      if (!regex.test(value)) return fail(`${path} does not match pattern ${schema.pattern}`);
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return fail(`${path} ${value} is less than minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) return fail(`${path} ${value} is greater than maximum ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) return fail(`${path} ${value} must be strictly greater than ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) return fail(`${path} ${value} must be strictly less than ${schema.exclusiveMaximum}`);
    if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
      const quotient = value / schema.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * Math.max(1, Math.abs(quotient)) * 8) {
        return fail(`${path} ${value} must be a multiple of ${schema.multipleOf}`);
      }
    }
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) return fail(`${path} length ${value.length} is less than minItems ${schema.minItems}`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) return fail(`${path} length ${value.length} is greater than maxItems ${schema.maxItems}`);
    if (schema.uniqueItems === true) {
      for (let i = 0; i < value.length; i++) {
        for (let j = i + 1; j < value.length; j++) {
          if (deepEqual(value[i], value[j])) return fail(`${path} must contain unique items`);
        }
      }
    }
    if (Array.isArray(schema.prefixItems)) {
      for (let i = 0; i < Math.min(value.length, schema.prefixItems.length); i++) {
        const result = validate(value[i], schema.prefixItems[i], root, `${path}[${i}]`, depth + 1);
        if (!result.valid) return result;
      }
    }
    if (schema.items !== undefined && !Array.isArray(schema.items)) {
      const start = Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0;
      for (let i = start; i < value.length; i++) {
        const result = validate(value[i], schema.items, root, `${path}[${i}]`, depth + 1);
        if (!result.valid) return result;
      }
    } else if (Array.isArray(schema.items)) {
      for (let i = 0; i < Math.min(value.length, schema.items.length); i++) {
        const result = validate(value[i], schema.items[i], root, `${path}[${i}]`, depth + 1);
        if (!result.valid) return result;
      }
    }
    if (schema.contains !== undefined) {
      const matches = value.reduce((count, item, index) => count + (validate(item, schema.contains, root, `${path}[${index}]`, depth + 1).valid ? 1 : 0), 0);
      const min = Number.isInteger(schema.minContains) ? schema.minContains : 1;
      const max = Number.isInteger(schema.maxContains) ? schema.maxContains : Infinity;
      if (matches < min || matches > max) return fail(`${path} contains ${matches} matching items, expected ${min}${max === Infinity ? '+' : `–${max}`}`);
    }
  }

  if (isObject(value)) {
    const keys = Object.keys(value);
    if (Number.isInteger(schema.minProperties) && keys.length < schema.minProperties) return fail(`${path} has fewer than ${schema.minProperties} properties`);
    if (Number.isInteger(schema.maxProperties) && keys.length > schema.maxProperties) return fail(`${path} has more than ${schema.maxProperties} properties`);
    if (Array.isArray(schema.required)) {
      for (const required of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, required)) return fail(`Missing required property "${required}" at ${path}`);
      }
    }

    const properties = isObject(schema.properties) ? schema.properties : {};
    const patternProperties = isObject(schema.patternProperties) ? schema.patternProperties : {};
    const compiledPatterns = [];
    for (const [pattern, patternSchema] of Object.entries(patternProperties)) {
      let regex;
      try { regex = new RegExp(pattern, 'u'); }
      catch { return fail(`${path} has invalid patternProperties expression ${pattern}`); }
      compiledPatterns.push([regex, patternSchema]);
    }

    for (const key of keys) {
      let matched = false;
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        matched = true;
        const result = validate(value[key], properties[key], root, `${path}.${escapePath(key)}`, depth + 1);
        if (!result.valid) return result;
      }
      for (const [regex, patternSchema] of compiledPatterns) {
        if (regex.test(key)) {
          matched = true;
          const result = validate(value[key], patternSchema, root, `${path}.${escapePath(key)}`, depth + 1);
          if (!result.valid) return result;
        }
      }
      if (!matched) {
        if (schema.additionalProperties === false) return fail(`Additional property "${key}" not allowed at ${path}`);
        if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
          const result = validate(value[key], schema.additionalProperties, root, `${path}.${escapePath(key)}`, depth + 1);
          if (!result.valid) return result;
        }
      }
    }

    if (isObject(schema.dependentRequired)) {
      for (const [key, requirements] of Object.entries(schema.dependentRequired)) {
        if (!Object.prototype.hasOwnProperty.call(value, key) || !Array.isArray(requirements)) continue;
        for (const required of requirements) {
          if (!Object.prototype.hasOwnProperty.call(value, required)) return fail(`${path}.${key} requires property "${required}"`);
        }
      }
    }
    if (schema.propertyNames !== undefined) {
      for (const key of keys) {
        const result = validate(key, schema.propertyNames, root, `${path} property name`, depth + 1);
        if (!result.valid) return result;
      }
    }
  }

  return ok();
}

function resolveRef(root, ref) {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) throw new Error(`Only local JSON Schema $ref values are supported: ${ref}`);
  let current = root;
  for (const rawPart of ref.slice(2).split('/')) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!current || typeof current !== 'object' || !(part in current)) throw new Error(`Unresolvable JSON Schema $ref: ${ref}`);
    current = current[part];
  }
  return current;
}

function checkType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return isObject(value);
    default: return true;
  }
}

function actualType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isObject(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function ok() { return { valid: true }; }
function fail(error) { return { valid: false, error }; }
function escapePath(value) { return String(value).replace(/[^A-Za-z0-9_$-]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`); }

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
}
