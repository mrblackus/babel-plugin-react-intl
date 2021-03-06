/*
 * Copyright 2015, Yahoo Inc.
 * Copyrights licensed under the New BSD License.
 * See the accompanying LICENSE file for terms.
 */

import * as p from 'path';
import {writeFileSync} from 'fs';
import {sync as mkdirpSync} from 'mkdirp';
import printICUMessage from './print-icu-message';

//Disable react-intl components to avoid conflict with T component
const COMPONENT_NAMES = [
    // 'FormattedMessage',
    // 'FormattedHTMLMessage',
];

const FUNCTION_NAMES = [
    'defineMessages',
];

const DESCRIPTOR_PROPS = new Set(['id', 'description', 'defaultMessage']);

const EXTRACTED_TAG = Symbol('ReactIntlExtracted');

const COMPONENT_NAME = 'T';
const MESSAGE_PROPERTY = 's';
const COMMENT_PROPERTY = 'c';

export default function ({types: t}) {
    function getModuleSourceName(opts) {
        return opts.moduleSourceName || 'react-intl';
    }

    function evaluatePath(path) {
        let evaluated = path.evaluate();
        if (evaluated.confident) {
            return evaluated.value;
        }

        throw path.buildCodeFrameError(
            '[React Intl] Messages must be statically evaluate-able for extraction.'
        );
    }

    function getMessageDescriptorKey(path) {
        if (path.isIdentifier() || path.isJSXIdentifier()) {
            return path.node.name;
        }

        return evaluatePath(path);
    }

    function getMessageDescriptorValue(path) {
        if (path.isJSXExpressionContainer()) {
            path = path.get('expression');
        }

        // Always trim the Message Descriptor values.
        return evaluatePath(path).trim();
    }

    function getICUMessageValue(messagePath, {isJSXSource = false} = {}) {
        let message = getMessageDescriptorValue(messagePath);

        try {
            return printICUMessage(message);
        } catch (parseError) {
            if (isJSXSource &&
                messagePath.isLiteral() &&
                message.indexOf('\\\\') >= 0) {

                throw messagePath.buildCodeFrameError(
                    '[React Intl] Message failed to parse. ' +
                    'It looks like `\\`s were used for escaping, ' +
                    'this won\'t work with JSX string literals. ' +
                    'Wrap with `{}`. ' +
                    'See: http://facebook.github.io/react/docs/jsx-gotchas.html'
                );
            }

            throw messagePath.buildCodeFrameError(
                '[React Intl] Message failed to parse. ' +
                'See: http://formatjs.io/guides/message-syntax/' +
                `\n${parseError}`
            );
        }
    }

    function createMessageDescriptor(propPaths, isTComp = false) {
        return propPaths.reduce((hash, [keyPath, valuePath]) => {
            let key = getMessageDescriptorKey(keyPath);

            //If it's a T component, take its s property for id and defaultMessage
            if (isTComp) {
                if (key === MESSAGE_PROPERTY) {
                    hash.id = valuePath;
                    hash.defaultMessage = valuePath;
                }
                else if (key === COMMENT_PROPERTY) {
                    hash[COMMENT_PROPERTY] = valuePath;
                }
            }
            else {
                if (DESCRIPTOR_PROPS.has(key)) {
                    hash[key] = valuePath;
                }
            }

            return hash;
        }, {});
    }

    function evaluateMessageDescriptor({...descriptor}, {isJSXSource = false} = {}) {
        Object.keys(descriptor).forEach((key) => {
            let valuePath = descriptor[key];

            if (key === 'defaultMessage') {
                descriptor[key] = getICUMessageValue(valuePath, {isJSXSource});
            } else {
                descriptor[key] = getMessageDescriptorValue(valuePath);
            }
        });

        return descriptor;
    }

    function storeMessage({id, description, defaultMessage, c}, path, state) {
        const {file, opts, reactIntl} = state;

        if (!(id && defaultMessage)) {
            throw path.buildCodeFrameError(
                '[React Intl] Message Descriptors require an `id` and `defaultMessage`.'
            );
        }

        if (reactIntl.messages.has(id)) {
            let existing = reactIntl.messages.get(id);

            if (description !== existing.description ||
                defaultMessage !== existing.defaultMessage) {

                throw path.buildCodeFrameError(
                    `[React Intl] Duplicate message id: "${id}", ` +
                    'but the `description` and/or `defaultMessage` are different.'
                );
            }
        }

        if (opts.enforceDescriptions && !description) {
            throw path.buildCodeFrameError(
                '[React Intl] Message must have a `description`.'
            );
        }

        let loc;
        if (opts.extractSourceLocation) {
            loc = {
                file: p.relative(process.cwd(), file.opts.filename),
                ...path.node.loc,
            };
        }

        if (c) {
            id += '##' + c;
        }

        reactIntl.messages.set(id, {id, description, defaultMessage, ...loc});
    }

    function referencesImport(path, mod, importedNames) {
        if (!(path.isIdentifier() || path.isJSXIdentifier())) {
            return false;
        }

        return importedNames.some((name) => path.referencesImport(mod, name));
    }

    function tagAsExtracted(path) {
        path.node[EXTRACTED_TAG] = true;
    }

    function wasExtracted(path) {
        return !!path.node[EXTRACTED_TAG];
    }

    return {
        visitor: {
            Program: {
                enter(path, state) {
                    state.reactIntl = {
                        messages: new Map(),
                    };
                },

                exit(path, state) {
                    const {file, opts, reactIntl} = state;
                    const {basename, filename}    = file.opts;

                    let descriptors = [...reactIntl.messages.values()];
                    file.metadata['react-intl'] = {messages: descriptors};

                    if (opts.messagesDir && descriptors.length > 0) {
                        // Make sure the relative path is "absolute" before
                        // joining it with the `messagesDir`.
                        let relativePath = p.join(
                            p.sep,
                            p.relative(process.cwd(), filename)
                        );

                        let messagesFilename = p.join(
                            opts.messagesDir,
                            p.dirname(relativePath),
                            basename + '.json'
                        );

                        let messagesFile = JSON.stringify(descriptors, null, 2);

                        mkdirpSync(p.dirname(messagesFilename));
                        writeFileSync(messagesFilename, messagesFile);
                    }
                },
            },

            JSXOpeningElement(path, state) {

                //Detect our own T component instead of react-intl's ones
                const isTComp = path.node.name.name === COMPONENT_NAME;

                if (wasExtracted(path)) {
                    return;
                }

                const {file, opts} = state;

                const moduleSourceName = getModuleSourceName(opts);
                const name = path.get('name');

                if (name.referencesImport(moduleSourceName, 'FormattedPlural')) {
                    file.log.warn(
                        `[React Intl] Line ${path.node.loc.start.line}: ` +
                        'Default messages are not extracted from ' +
                        '<FormattedPlural>, use <FormattedMessage> instead.'
                    );

                    return;
                }

                if (referencesImport(name, moduleSourceName, COMPONENT_NAMES) || isTComp) {

                    let attributes = path.get('attributes')
                        .filter((attr) => attr.isJSXAttribute());

                    let descriptor = createMessageDescriptor(
                        attributes.map((attr) => [
                            attr.get('name'),
                            attr.get('value'),
                        ]), isTComp
                    );

                    // In order for a default message to be extracted when
                    // declaring a JSX element, it must be done with standard
                    // `key=value` attributes. But it's completely valid to
                    // write `<FormattedMessage {...descriptor} />` or
                    // `<FormattedMessage id={dynamicId} />`, because it will be
                    // skipped here and extracted elsewhere. The descriptor will
                    // be extracted only if a `defaultMessage` prop exists.
                    if (descriptor.defaultMessage) {
                        // Evaluate the Message Descriptor values in a JSX
                        // context, then store it.
                        descriptor = evaluateMessageDescriptor(descriptor, {
                            isJSXSource: true,
                        });

                        storeMessage(descriptor, path, state);

                        // Remove description since it's not used at runtime.
                        attributes.some((attr) => {
                            let ketPath = attr.get('name');
                            if (getMessageDescriptorKey(ketPath) === 'description') {
                                attr.remove();
                                return true;
                            }
                        });

                        // Tag the AST node so we don't try to extract it twice.
                        tagAsExtracted(path);
                    }
                }
            },

            CallExpression(path, state) {

                if (wasExtracted(path)) {
                    return;
                }

                const callee = path.get('callee');

                if (callee.node.name === 't') {

                    const [textPath, _, cPath] = path.get('arguments');
                    const text = getICUMessageValue(textPath);
                    const c = cPath ? getMessageDescriptorValue(cPath) : undefined;


                    storeMessage({
                        id: text,
                        defaultMessage: text,
                        c,
                    }, path, state);
                    tagAsExtracted(path);
                }

            },
        },
    };
}
