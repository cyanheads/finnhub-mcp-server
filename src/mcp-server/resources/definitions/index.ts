/**
 * @fileoverview Barrel collecting all resource definitions into
 * `allResourceDefinitions` for `createApp()`.
 * @module mcp-server/resources/definitions/index
 */

import { newsCategoriesResource } from './news-categories.resource.js';

export const allResourceDefinitions = [newsCategoriesResource];
