import {
  AliasDeclarationNode,
  ArrayExpressionNode,
  ExportStatementNode,
  ExpressionNode,
  ExtendsClauseNode,
  GenericExpressionNode,
  IdentifierNode,
  ImportClauseNode,
  ImportStatementNode,
  InferClauseNode,
  InterfaceDeclarationNode,
  LiteralNode,
  MappedTypeNode,
  NodeType,
  ObjectExpressionNode,
  PropertyNode,
  StatementNode,
  UnionExpressionNode,
} from '../ast';

const IDENTIFIER_REGEXP = /^[$A-Z_a-z][\w$]*$/;

export type SerializerOptions = {
  typeOnlyImports?: boolean;
};

/**
 * Creates a TypeScript output string from a codegen AST.
 */
export class Serializer {
  readonly typeOnlyImports: boolean;
  private serializableTypeNames: Set<string> = new Set();

  constructor(options: SerializerOptions = {}) {
    this.typeOnlyImports = options.typeOnlyImports ?? true;
  }

  getExpression(node: AliasDeclarationNode): ExpressionNode {
    return node.body.type === NodeType.TEMPLATE
    ? node.body.expression
    : node.body;
  }

  collectSerializableTypes(nodes: StatementNode[]): void {
    this.serializableTypeNames.clear();

    for (const node of nodes) {
      if (node.type !== NodeType.EXPORT_STATEMENT) continue;
      if (node.argument.type !== NodeType.ALIAS_DECLARATION) continue;

      if (this.serializableTypeNames.has(node.argument.name)) continue;

      const expression = this.getExpression(node.argument);

      if (this.isSerializableToZod(expression, nodes)) {
        this.serializableTypeNames.add(node.argument.name);
      }
    }
  }

  sortNodesByDependency(nodes: StatementNode[]): StatementNode[] {
    return [...nodes].sort((a, b) => {
      if (a.type !== NodeType.EXPORT_STATEMENT ||
          b.type !== NodeType.EXPORT_STATEMENT ||
          a.argument.type !== NodeType.ALIAS_DECLARATION ||
          b.argument.type !== NodeType.ALIAS_DECLARATION) {
        return 0;
      }

      const aExpr = this.getExpression(a.argument);
      const bExpr = this.getExpression(b.argument);

      if (aExpr.type === NodeType.OBJECT_EXPRESSION && bExpr.type === NodeType.ARRAY_EXPRESSION) return -1;
      if (aExpr.type === NodeType.ARRAY_EXPRESSION && bExpr.type === NodeType.OBJECT_EXPRESSION) return 1;

      return 0;
    })
  }

  findAliasDeclaration(nodes: StatementNode[], name: string): AliasDeclarationNode | undefined {
    for (const node of nodes) {
      if (node.type !== NodeType.EXPORT_STATEMENT) continue;
      if (node.argument.type !== NodeType.ALIAS_DECLARATION) continue;
      if (node.argument.name === name) {
        return node.argument;
      }
    }
    return undefined;
  }

  isStringLiteralUnion(node: UnionExpressionNode): boolean {
    if (!node.args.length) return false;

    return node.args.every(
      (arg) => arg.type === NodeType.LITERAL && typeof arg.value === 'string',
    );
  }

  isSerializableToZod(node: ExpressionNode, allNodes?: StatementNode[]): boolean {
    switch (node.type) {
      case NodeType.OBJECT_EXPRESSION:
        return true;
      case NodeType.ARRAY_EXPRESSION:
        return this.isSerializableToZod((node as ArrayExpressionNode).values, allNodes);
      case NodeType.IDENTIFIER:
        const name = (node as IdentifierNode).name;
        if (this.serializableTypeNames.has(name)) return true;

        const zodResult = this.serializeIdentifierZod(node as IdentifierNode);
        if (zodResult.startsWith('z.') || zodResult === '.optional()') return true;

        if (allNodes) {
          const referencedAlias = this.findAliasDeclaration(allNodes, name);

          if (referencedAlias) {
            const refExpr = this.getExpression(referencedAlias);
            return this.isSerializableToZod(refExpr, allNodes);
          }
        }
        return false;
      case NodeType.LITERAL:
        return true;
      case NodeType.UNION_EXPRESSION:
        return this.isStringLiteralUnion(node as UnionExpressionNode);
      case NodeType.GENERIC_EXPRESSION:
      case NodeType.EXTENDS_CLAUSE:
      case NodeType.MAPPED_TYPE:
      case NodeType.INFER_CLAUSE:
        return false;
    }
  }

  serialize(nodes: StatementNode[]) {
    this.collectSerializableTypes(nodes);
    const sortedNodes = this.sortNodesByDependency(nodes);

    let data = '';
    let i = 0;

    for (const node of sortedNodes) {
      if (i >= 1) {
        data += '\n';

        if (node.type !== NodeType.IMPORT_STATEMENT) {
          data += '\n';
        }
      }

      switch (node.type) {
        case NodeType.EXPORT_STATEMENT:
          data += this.serializeExportStatementZod(node);
          data += '\n';
          data += this.serializeExportStatement(node);
          break;
        case NodeType.IMPORT_STATEMENT:
          data += this.serializeImportStatement(node);
          break;
      }

      i++;
    }

    data += '\n';

    return data;
  }

  serializeAliasDeclaration(node: AliasDeclarationNode) {
    const expression =
      node.body.type === NodeType.TEMPLATE ? node.body.expression : node.body;
    let data = '';

    data += 'type ';
    data += node.name;

    if (node.body.type === NodeType.TEMPLATE) {
      data += '<';

      for (let i = 0; i < node.body.params.length; i++) {
        if (i >= 1) {
          data += ', ';
        }

        data += node.body.params[i]!;
      }

      data += '>';
    }

    data += ' = ';
    data += this.serializeExpression(expression);
    data += ';';

    return data;
  }

  serializeArrayExpression(node: ArrayExpressionNode) {
    const shouldParenthesize =
      node.values.type === NodeType.UNION_EXPRESSION &&
      node.values.args.length >= 2;
    let data = '';

    if (shouldParenthesize) {
      data += '(';
    }

    data += this.serializeExpression(node.values);

    if (shouldParenthesize) {
      data += ')';
    }

    data += '[]';

    return data;
  }

  serializeExportStatement(node: ExportStatementNode) {
    let data = '';

    data += 'export ';

    switch (node.argument.type) {
      case NodeType.ALIAS_DECLARATION:
        data += this.serializeAliasDeclaration(node.argument);
        break;
      case NodeType.INTERFACE_DECLARATION:
        data += this.serializeInterfaceDeclaration(node.argument);
        break;
    }

    return data;
  }

  serializeExpression(node: ExpressionNode) {

    switch (node.type) {
      case NodeType.ARRAY_EXPRESSION:
        return this.serializeArrayExpression(node);
      case NodeType.EXTENDS_CLAUSE:
        return this.serializeExtendsClause(node);
      case NodeType.GENERIC_EXPRESSION:
        return this.serializeGenericExpression(node);
      case NodeType.IDENTIFIER:
        return this.serializeIdentifier(node);
      case NodeType.INFER_CLAUSE:
        return this.serializeInferClause(node);
      case NodeType.LITERAL:
        return this.serializeLiteral(node);
      case NodeType.MAPPED_TYPE:
        return this.serializeMappedType(node);
      case NodeType.OBJECT_EXPRESSION:
        return this.serializeObjectExpression(node);
      case NodeType.UNION_EXPRESSION:
        return this.serializeUnionExpression(node);
    }
  }

  serializeExtendsClause(node: ExtendsClauseNode) {
    let data = '';

    data += node.name;
    data += ' extends ';
    data += this.serializeExpression(node.test);
    data += '\n  ? ';
    data += this.serializeExpression(node.consequent);
    data += '\n  : ';
    data += this.serializeExpression(node.alternate);

    return data;
  }

  serializeGenericExpression(node: GenericExpressionNode) {
    let data = '';

    data += node.name;
    data += '<';

    for (let i = 0; i < node.args.length; i++) {
      if (i >= 1) {
        data += ', ';
      }

      data += this.serializeExpression(node.args[i]!);
    }

    data += '>';

    return data;
  }

  serializeIdentifier(node: IdentifierNode) {
    return node.name;
  }

  serializeImportClause(node: ImportClauseNode) {
    let data = '';

    data += node.name;

    if (node.alias) {
      data += ' as ';
      data += node.alias;
    }

    return data;
  }

  serializeImportStatement(node: ImportStatementNode) {
    let data = '';
    let i = 0;

    data += 'import ';

    // if (this.typeOnlyImports) {
    //   data += 'type ';
    // }

    data += '{';

    for (const importClause of node.imports) {
      if (i >= 1) {
        data += ',';
      }

      data += ' ';
      data += this.serializeImportClause(importClause);
      i++;
    }

    data += ' } from ';
    data += JSON.stringify(node.moduleName);
    data += ';';

    return data;
  }

  serializeInferClause(node: InferClauseNode) {
    let data = '';

    data += 'infer ';
    data += node.name;

    return data;
  }

  serializeInterfaceDeclaration(node: InterfaceDeclarationNode) {
    let data = '';

    data += 'interface ';
    data += node.name;
    data += ' ';
    data += this.serializeObjectExpression(node.body);

    return data;
  }

  serializeLiteral(node: LiteralNode) {
    return JSON.stringify(node.value);
  }

  serializeKey(key: string) {
    return IDENTIFIER_REGEXP.test(key) ? key : JSON.stringify(key);
  }

  serializeMappedType(node: MappedTypeNode) {
    let data = '';

    data += '{\n  [K in string]?: ';
    data += this.serializeExpression(node.value);
    data += ';\n}';

    return data;
  }

  serializeObjectExpression(node: ObjectExpressionNode) {
    let data = '';

    data += '{';

    if (node.properties.length > 0) {
      data += '\n';

      const sortedProperties = [...node.properties].sort((a, b) =>
        a.key.localeCompare(b.key),
      );

      for (const property of sortedProperties) {
        data += '  ';
        data += this.serializeProperty(property);
      }
    }

    data += '}';

    return data;
  }

  serializeProperty(node: PropertyNode) {
    let data = '';

    const desc = node.description?.trim()

    if (desc && desc.length > 0) {
      data += `/** ${desc} */\n`
    }

    data += this.serializeKey(node.key);
    data += ': ';
    data += this.serializeExpression(node.value);
    data += ';\n';

    return data;
  }

  serializeUnionExpression(node: UnionExpressionNode) {
    let data = '';
    let i = 0;

    const sortedArgs = [...node.args].sort((a, b) => {
      if (a.type !== NodeType.IDENTIFIER || b.type !== NodeType.IDENTIFIER) {
        return 0;
      }
      if (a.name === undefined || a.name === 'undefined') return 1;
      if (b.name === undefined || b.name === 'undefined') return -1;
      if (a.name === null || a.name === 'null') return 1;
      if (b.name === null || b.name === 'null') return -1;
      if (a.name < b.name) return -1;
      if (a.name > b.name) return 1;
      return 0;
    });

    for (const arg of sortedArgs) {
      if (i >= 1) {
        data += ' | ';
      }

      data += this.serializeExpression(arg);
      i++;
    }

    return data;
  }


  /**
   * ZOD STUFF
   */

  serializeAliasDeclarationZod(node: AliasDeclarationNode) {
    const expression =
      node.body.type === NodeType.TEMPLATE ? node.body.expression : node.body;
    let data = '';

    data += 'const ';
    data += node.name;

    // if (node.body.type === NodeType.TEMPLATE) {
    //   data += '<';

    //   for (let i = 0; i < node.body.params.length; i++) {
    //     if (i >= 1) {
    //       data += ', ';
    //     }

    //     data += node.body.params[i]!;
    //   }

    //   data += '>';
    // }

    data += ' = ';
    data += this.serializeExpressionZod(expression);
    data += ';';

    return data;
  }

  serializeArrayExpressionZod(node: ArrayExpressionNode) {
    const shouldParenthesize =
      node.values.type === NodeType.UNION_EXPRESSION &&
      node.values.args.length >= 2;
    let data = 'z.array(';

    if (shouldParenthesize) {
      data += 'z.union(';
    }

    data += this.serializeExpressionZod(node.values);

    if (shouldParenthesize) {
      data += ')';
    }

    data += ')';

    return data;
  }

  serializeExportStatementZod(node: ExportStatementNode) {
    let data = '';

    data += 'export ';

    switch (node.argument.type) {
      case NodeType.ALIAS_DECLARATION:
        const expression = this.getExpression(node.argument);

        if (this.isSerializableToZod(expression)) {
          data += this.serializeAliasDeclarationZod(node.argument);
        } else {
          return '';
        }
        break;
      case NodeType.INTERFACE_DECLARATION:
        data += this.serializeInterfaceDeclarationZod(node.argument);
        break;
    }

    return data;
  }

  serializeExpressionZod(node: ExpressionNode) {
    const res = (() => {
      switch (node.type) {
        case NodeType.ARRAY_EXPRESSION:
          return this.serializeArrayExpressionZod(node);
        case NodeType.EXTENDS_CLAUSE:
          return this.serializeExtendsClauseZod(node);
        case NodeType.GENERIC_EXPRESSION:
          return this.serializeGenericExpressionZod(node);
        case NodeType.IDENTIFIER:
          return this.serializeIdentifierZod(node);
        case NodeType.INFER_CLAUSE:
          return this.serializeInferClauseZod(node);
        case NodeType.LITERAL:
          return this.serializeLiteralZod(node);
        case NodeType.MAPPED_TYPE:
          return this.serializeMappedTypeZod(node);
        case NodeType.OBJECT_EXPRESSION:
          return this.serializeObjectExpressionZod(node);
        case NodeType.UNION_EXPRESSION:
          return this.serializeUnionExpressionZod(node);
      }
    })();

    return res;
  }

  serializeExtendsClauseZod(node: ExtendsClauseNode) {
    let data = '';

    data += node.name;
    data += ' extends ';
    data += this.serializeExpressionZod(node.test);
    data += '\n  ? ';
    data += this.serializeExpressionZod(node.consequent);
    data += '\n  : ';
    data += this.serializeExpressionZod(node.alternate);

    return data;
  }

  serializeGenericExpressionZod(node: GenericExpressionNode) {
    let data = '';

    // data += node.name;
    // data += '<';

    for (let i = 0; i < node.args.length; i++) {
      if (i >= 1) {
        data += ', ';
      }

      data += this.serializeExpressionZod(node.args[i]!);
    }

    // data += '>';

    return data;
  }

  serializeIdentifierZod(node: IdentifierNode) {

    if (node.name.includes('Decimal')) {
      return 'z.coerce.number()';
    }

    switch (node.name) {
      case 'Object':
      case 'Json':
        return 'z.unknown()';
      case 'boolean':
      case 'Boolean':
        return 'z.boolean()';
      case 'Date':
      case 'Date32':
      case 'DateTime':
      case 'DateTime64':
        return 'z.coerce.date()';
      case 'null':
      case 'Nullable':
        return 'z.null()';
      case 'Decimal':
      case 'Int8':
      case 'Int16':
      case 'Int32':
      case 'Int64':
      case 'Int128':
      case 'Int256':
      case 'UInt8':
      case 'UInt16':
      case 'UInt32':
      case 'UInt64':
      case 'UInt128':
      case 'UInt256':
      case 'number':
      case 'Numeric':
        return 'z.coerce.number()';
      case 'string':
      case 'String':
        return 'z.string()';
      case 'Timestamp':
        return 'z.coerce.date()';
      case 'undefined':
        return '.optional()';
    }
    return node.name;
  }

  serializeImportClauseZod(node: ImportClauseNode) {
    let data = '';

    data += node.name;

    if (node.alias) {
      data += ' as ';
      data += node.alias;
    }

    return data;
  }

  serializeImportStatementZod(node: ImportStatementNode) {
    let data = '';
    let i = 0;

    data += 'import ';

    data += '{';

    for (const importClause of node.imports) {
      if (i >= 1) {
        data += ',';
      }

      data += ' ';
      data += this.serializeImportClauseZod(importClause);
      i++;
    }

    data += ' } from ';
    data += JSON.stringify(node.moduleName);
    data += ';';

    return data;
  }

  serializeInferClauseZod(node: InferClauseNode) {
    let data = '';

    data += 'infer ';
    data += node.name;

    return data;
  }

  serializeInterfaceDeclarationZod(node: InterfaceDeclarationNode) {
    let data = '';

    data += 'const ';
    data += node.name;
    data += ' = ';
    data += this.serializeObjectExpressionZod(node.body);

    return data;
  }

  serializeLiteralZod(node: LiteralNode) {
    return JSON.stringify(node.value);
  }

  serializeKeyZod(key: string) {
    return IDENTIFIER_REGEXP.test(key) ? key : JSON.stringify(key);
  }

  serializeMappedTypeZod(node: MappedTypeNode) {
    let data = '';

    data += '{\n  [K in string]?: ';
    data += this.serializeExpressionZod(node.value);
    data += ';\n}';

    return data;
  }

  serializeObjectExpressionZod(node: ObjectExpressionNode) {
    let data = '';

    data += 'z.object({';

    if (node.properties.length) {
      data += '\n';

      for (const property of node.properties) {
        data += '  ';
        data += this.serializePropertyZod(property);
      }
    }

    data += '})';

    return data;
  }

  serializePropertyZod(node: PropertyNode) {
    let data = '';

    const desc = node.description?.trim()

    if (desc && desc.length > 0) {
      data += `/** ${desc} */\n`
    }

    data += this.serializeKeyZod(node.key);
    data += ': ';
    data += this.serializeExpressionZod(node.value);

    if (desc && desc.length > 0) {
      const description = JSON.stringify(desc)

      if (description.length > 2) {
        data += `.describe(${description})`
      }

    }

    data += ',\n';

    return data;
  }

  serializeNullableExpressionZod(node: UnionExpressionNode) {

    const [first, second] = node.args


    // this is just to make ts happy
    if (!first || !second) {
      return '';
    }

    let data: string = this.serializeExpressionZod(first);

    // again, this shouldn't happen. in sql, we can't really union different values types.
    // so the second expression is pretty much always a null
    if (second.type !== NodeType.IDENTIFIER) {
      return data
    }

    if (second.name !== 'null') {
      return data
    }

    data += '.nullish()';

    return data;
  }

  serializeUnionExpressionZod(node: UnionExpressionNode) {

    if (node.args.length === 2) {
      const [_first, second] = node.args;

      // Only use nullable serialization if the second argument is actually null
      if (second && second.type === NodeType.IDENTIFIER && second.name === 'null') {
        return this.serializeNullableExpressionZod(node);
      }
    }

    let data = 'z.enum([';
    let i = 0;

    for (const arg of node.args) {
      if (i >= 1) {
        data += ', ';
      }

      const exp = this.serializeExpressionZod(arg);

      data += exp

      i++;
    }

    data += '])';

    return data;
  }
}
