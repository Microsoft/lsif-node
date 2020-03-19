# lsif-tsc
> *Languag Server Index Format tool for TypeScript*

### Requirements

- [Node.js](https://nodejs.org/en/) at least `10.x.x`

### About

This tool supports creating LSIF dumps for TypeScript and JavaScript.

See also the [Language Server Index Format Specification](https://github.com/Microsoft/language-server-protocol/blob/master/indexFormat/specification.md)

### How to Run the Tool

The easiest way to run the tool is to install the latest version (which are pre-release version starting with 0.x right now):

```
npm install -g lsif-tsc
```

Then execute the command on a TypeScipt project using the following command:

```
lsif-tsc -p tsconfig.json --out=dump.lsif
```

This saves an LSIF dump to `dump.lsif`.

You might also want to execute `list-tsc --help` to get an overview of available command line options. Also of interest could be the overall [readme](https://github.com/microsoft/lsif-node/blob/master/README.md)
