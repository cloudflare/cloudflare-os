export const preferJsdoc = {
  meta: {
    type: "layout",
    docs: {
      description: "Require JSDoc syntax for exported declaration comments",
    },
    fixable: "whitespace",
    messages: {
      useJsdoc: "Use a JSDoc comment (`/** ... */`) to document an exported declaration.",
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const apiRootTypes = new Set([
      "ClassDeclaration",
      "ClassExpression",
      "FunctionDeclaration",
      "TSDeclareFunction",
      "TSInterfaceDeclaration",
      "TSTypeAliasDeclaration",
      "TSEnumDeclaration",
      "VariableDeclaration",
    ]);
    const classMemberTypes = new Set([
      "AccessorProperty",
      "MethodDefinition",
      "PropertyDefinition",
      "TSAbstractAccessorProperty",
      "TSAbstractMethodDefinition",
      "TSAbstractPropertyDefinition",
      "TSParameterProperty",
    ]);

    function startsOnOwnLine(comment) {
      const lineStart = sourceCode.text.lastIndexOf("\n", comment.range[0] - 1) + 1;
      return sourceCode.text.slice(lineStart, comment.range[0]).trim() === "";
    }

    function checkComments(node) {
      const comments = sourceCode.getCommentsBefore(node);
      const lastComment = comments.at(-1);
      if (!lastComment || lastComment.loc.end.line + 1 !== node.loc.start.line ||
          !startsOnOwnLine(lastComment)) return;

      if (lastComment.type === "Block") {
        const text = sourceCode.getText(lastComment);
        if (text.startsWith("/**") || text.startsWith("/*!") ||
            /^(?:[#@]__(?:NO_SIDE_EFFECTS|PURE)__|@ts-|c8 |eslint-|istanbul |oxlint-|prettier-|biome-)/i
              .test(lastComment.value.trimStart())) return;
        context.report({
          node,
          loc: lastComment.loc,
          messageId: "useJsdoc",
          fix: (fixer) => fixer.replaceTextRange(
            [lastComment.range[0], lastComment.range[0] + 2],
            "/**",
          ),
        });
        return;
      }
      if (lastComment.type !== "Line") return;

      let firstIndex = comments.length - 1;
      while (firstIndex > 0) {
        const previous = comments[firstIndex - 1];
        const current = comments[firstIndex];
        if (previous.type !== "Line" ||
            previous.loc.end.line + 1 !== current.loc.start.line) break;
        firstIndex--;
      }

      const docComments = comments.slice(firstIndex);
      if (docComments.some((comment) => !startsOnOwnLine(comment))) return;

      if (docComments.some((comment) =>
        sourceCode.getText(comment).startsWith("///") ||
        /^(?:@ts-|c8 |eslint-|istanbul |oxlint-|prettier-|biome-)/i
          .test(comment.value.trimStart()))) return;

      const firstComment = docComments[0];
      const indent = " ".repeat(firstComment.loc.start.column);
      const replacement = docComments.length === 1
        ? `/**${firstComment.value.trimEnd()} */`
        : `/**\n${docComments.map((comment) =>
          `${indent} *${comment.value.trimEnd()}`).join("\n")}\n${indent} */`;

      const report = {
        node,
        loc: {
          start: firstComment.loc.start,
          end: lastComment.loc.end,
        },
        messageId: "useJsdoc",
      };
      if (!docComments.some((comment) => comment.value.includes("*/"))) {
        report.fix = (fixer) => fixer.replaceTextRange(
          [firstComment.range[0], lastComment.range[1]],
          replacement,
        );
      }
      context.report(report);
    }

    function checkExport(node) {
      if (node.declaration) checkComments(node);
    }

    function isExportedApiMember(node) {
      if (node.accessibility === "private" || node.key?.type === "PrivateIdentifier") return false;

      let root = node.parent;
      while (root) {
        if (classMemberTypes.has(root.type) &&
            (root.accessibility === "private" || root.key?.type === "PrivateIdentifier")) {
          return false;
        }
        if ((root.type === "FunctionDeclaration" || root.type === "FunctionExpression" ||
            root.type === "ArrowFunctionExpression") && root.body &&
            node.range[0] >= root.body.range[0] && node.range[1] <= root.body.range[1]) {
          return false;
        }
        if ((root.type === "PropertyDefinition" || root.type === "AccessorProperty") && root.value &&
            node.range[0] >= root.value.range[0] && node.range[1] <= root.value.range[1]) {
          return false;
        }
        if (root.type === "StaticBlock") return false;
        if (apiRootTypes.has(root.type)) break;
        root = root.parent;
      }
      if (!root) return false;

      let parent = root.parent;
      while (parent?.type === "VariableDeclarator" || parent?.type === "VariableDeclaration") {
        parent = parent.parent;
      }
      return (parent?.type === "ExportDefaultDeclaration" ||
          parent?.type === "ExportNamedDeclaration") && parent.declaration !== null;
    }

    function checkApiMember(node) {
      if (isExportedApiMember(node)) checkComments(node);
    }

    const apiMemberSelector =
      ":matches(AccessorProperty, MethodDefinition, PropertyDefinition, " +
      "TSAbstractAccessorProperty, TSAbstractMethodDefinition, TSAbstractPropertyDefinition, " +
      "TSCallSignatureDeclaration, TSConstructSignatureDeclaration, TSEnumMember, " +
      "TSIndexSignature, TSMethodSignature, TSParameterProperty, TSPropertySignature)";

    return {
      ":matches(ExportDefaultDeclaration, ExportNamedDeclaration)": checkExport,
      [apiMemberSelector]: checkApiMember,
    };
  },
};

export default {
  meta: {
    name: "gadgets",
  },
  rules: {
    "prefer-jsdoc": preferJsdoc,
  },
};
