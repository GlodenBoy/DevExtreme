import { errors as dataErrors } from "@js/common/data/errors";
import { Deferred, when } from "@js/core/utils/deferred";
import { extend } from "@js/core/utils/extend";
import { each } from "@js/core/utils/iterator";
import { toComparable } from "@js/core/utils/data";
import errors from "@js/ui/widget/ui.errors";

import dataGridCore from "../m_core";
import { createGroupFilter } from "../m_utils";
import {
  createOffsetFilter,
  GroupingHelper as GroupingHelperCore,
} from "./m_grouping_core";

function getContinuationGroupCount(
  groupOffset,
  pageSize,
  groupSize,
  groupIndex
) {
  groupIndex = groupIndex || 0;
  if (pageSize > 1 && groupSize > 0) {
    let pageOffset =
      groupOffset - Math.floor(groupOffset / pageSize) * pageSize || pageSize;
    pageOffset += groupSize - groupIndex - 2;
    if (pageOffset < 0) {
      pageOffset += pageSize;
    }
    return Math.floor(pageOffset / (pageSize - groupIndex - 1));
  }
  return 0;
}

const foreachExpandedGroups = function (that, callback, updateGroups?) {
  return that.foreachGroups(
    (groupInfo, parents) => {
      if (groupInfo.isExpanded) {
        return callback(groupInfo, parents);
      }
    },
    true,
    false,
    updateGroups,
    updateGroups
  );
};

const processGroupItems = function (
  that,
  items,
  groupsCount,
  expandedInfo,
  path,
  isCustomLoading?,
  isLastGroupExpanded?
) {
  let isExpanded;

  expandedInfo.items = expandedInfo.items || [];
  expandedInfo.paths = expandedInfo.paths || [];
  expandedInfo.count = expandedInfo.count || 0;
  expandedInfo.lastCount = expandedInfo.lastCount || 0;

  if (!groupsCount) return;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.items !== undefined) {
      path.push(item.key);

      if (isCustomLoading) {
        isExpanded = true;
      } else {
        const groupInfo = that.findGroupInfo(path);
        isExpanded = groupInfo && groupInfo.isExpanded;
      }
      if (!isExpanded) {
        item.collapsedItems = item.items;
        item.items = null;
      } else if (item.items) {
        processGroupItems(
          that,
          item.items,
          groupsCount - 1,
          expandedInfo,
          path,
          isCustomLoading,
          isLastGroupExpanded
        );
      } else if (
        groupsCount === 1 &&
        item.count &&
        (!isCustomLoading || isLastGroupExpanded)
      ) {
        console.log("[processGroupItems] 发现需要加载的分组项:", {
          path: path.slice(0),
          itemKey: item.key,
          itemCount: item.count,
        });
        expandedInfo.items.push(item);
        expandedInfo.paths.push(path.slice(0));
        expandedInfo.count += expandedInfo.lastCount;
        expandedInfo.lastCount = item.count;
      }
      path.pop();
    }
  }
};

const updateGroupInfoItem = function (
  that,
  item,
  isLastGroupLevel,
  path,
  offset
) {
  const groupInfo = that.findGroupInfo(path);
  let count;

  if (!groupInfo) {
    if (isLastGroupLevel) {
      count = item.count > 0 ? item.count : item.items.length;
    }

    that.addGroupInfo({
      isExpanded: that._isGroupExpanded(path.length - 1),
      path: path.slice(0),
      offset,
      count: count || 0,
    });
  } else {
    if (isLastGroupLevel) {
      groupInfo.count =
        item.count > 0 ? item.count : (item.items && item.items.length) || 0;
    } else {
      item.count = groupInfo.count || item.count;
    }
    groupInfo.offset = offset;
  }
};

const updateGroupInfos = function (
  that,
  options,
  items,
  loadedGroupCount,
  groupIndex?,
  path?,
  parentIndex?
) {
  const groupCount = options.group ? options.group.length : 0;
  const isLastGroupLevel = groupCount === loadedGroupCount;
  const remotePaging = options.remoteOperations.paging;
  let offset = 0;
  let totalCount = 0;
  let count;

  groupIndex = groupIndex || 0;
  path = path || [];

  if (remotePaging && !parentIndex) {
    offset =
      groupIndex === 0 ? options.skip || 0 : options.skips[groupIndex - 1] || 0;
  }

  if (groupIndex >= loadedGroupCount) return items.length;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item) {
      path.push(item.key);

      if ((!item.count && !item.items) || item.items === undefined) {
        return -1;
      }

      updateGroupInfoItem(that, item, isLastGroupLevel, path, offset + i);

      count = item.items
        ? updateGroupInfos(
            that,
            options,
            item.items,
            loadedGroupCount,
            groupIndex + 1,
            path,
            i
          )
        : item.count || -1;
      if (count < 0) {
        return -1;
      }
      totalCount += count;
      path.pop();
    }
  }
  return totalCount;
};

const isGroupExpanded = function (groups, groupIndex) {
  return (
    groups &&
    groups.length &&
    groups[groupIndex] &&
    !!groups[groupIndex].isExpanded
  );
};

const getTotalOffset = function (groupInfos, pageSize, offset) {
  let groupSize;
  let totalOffset = offset;

  for (let groupIndex = 0; groupIndex < groupInfos.length; groupIndex++) {
    groupSize = groupInfos[groupIndex].offset + 1;
    if (groupIndex > 0) {
      groupSize += groupInfos[groupIndex - 1].childrenTotalCount;
      if (pageSize) {
        groupSize +=
          getContinuationGroupCount(
            totalOffset,
            pageSize,
            groupSize,
            groupIndex - 1
          ) * groupIndex;
      }
    }
    totalOffset += groupSize;
  }

  return totalOffset;
};

function applyContinuationToGroupItem(
  options,
  expandedInfo,
  groupLevel,
  expandedItemIndex
) {
  const item = expandedInfo.items[expandedItemIndex];
  const skip = options.skips && options.skips[groupLevel];
  const take = options.takes && options.takes[groupLevel];
  const isLastExpandedItem =
    expandedItemIndex === expandedInfo.items.length - 1;
  const isFirstExpandedItem = expandedItemIndex === 0;
  const lastExpandedItemSkip = (isFirstExpandedItem && skip) || 0;
  const isItemsTruncatedByTake = item.count > take + lastExpandedItemSkip;

  if (isFirstExpandedItem && skip !== undefined) {
    item.isContinuation = true;
  }

  if (isLastExpandedItem && take !== undefined && isItemsTruncatedByTake) {
    item.isContinuationOnNextPage = true;
  }
}

function fillSkipTakeInExpandedInfo(options, expandedInfo, currentGroupCount) {
  const currentGroupIndex = currentGroupCount - 1;
  const groupCount = options.group ? options.group.length : 0;

  expandedInfo.skip = options.skips && options.skips[currentGroupIndex];
  if (options.takes && options.takes[currentGroupIndex] !== undefined) {
    if (groupCount === currentGroupCount) {
      expandedInfo.take = expandedInfo.count
        ? expandedInfo.count - (expandedInfo.skip || 0)
        : 0;
    } else {
      expandedInfo.take = 0;
    }
    expandedInfo.take += options.takes[currentGroupIndex];
  }
}

function isDataDeferred(data) {
  return !Array.isArray(data);
}

function makeDataDeferred(options) {
  if (!isDataDeferred(options.data)) {
    // @ts-expect-error
    options.data = new Deferred();
  }
}

function loadGroupItems(
  that,
  options,
  loadedGroupCount,
  expandedInfo,
  groupLevel,
  data
) {
  if (!options.isCustomLoading) {
    expandedInfo = {};

    processGroupItems(that, data, loadedGroupCount, expandedInfo, []);

    fillSkipTakeInExpandedInfo(options, expandedInfo, loadedGroupCount);
  }

  const groupCount = options.group ? options.group.length : 0;

  console.log("[loadGroupItems] 检查需要加载的分组:", {
    pathsCount: expandedInfo.paths ? expandedInfo.paths.length : 0,
    itemsCount: expandedInfo.items ? expandedInfo.items.length : 0,
    groupCount,
    loadedGroupCount,
    needLoadExpandedGroups:
      expandedInfo.paths.length && groupCount - loadedGroupCount > 0,
    needLoadLastLevel:
      expandedInfo.paths.length && options.storeLoadOptions.group,
  });

  if (expandedInfo.paths.length && groupCount - loadedGroupCount > 0) {
    makeDataDeferred(options);
    loadExpandedGroups(
      that,
      options,
      expandedInfo,
      loadedGroupCount,
      groupLevel,
      data
    );
  } else if (expandedInfo.paths.length && options.storeLoadOptions.group) {
    console.log("[loadGroupItems] 调用 loadLastLevelGroupItems");
    makeDataDeferred(options);
    loadLastLevelGroupItems(that, options, expandedInfo, data);
  } else if (isDataDeferred(options.data)) {
    options.data.resolve(data);
  }
}

function loadExpandedGroups(
  that,
  options,
  expandedInfo,
  loadedGroupCount,
  groupLevel,
  data
) {
  const groups = options.group || [];
  const currentGroup = groups[groupLevel + 1];
  const deferreds: any[] = [];

  // 获取 columnsController，用于判断多值字段
  const columnsController =
    that._dataSource?._dataController?._columnsController;

  each(expandedInfo.paths, (expandedItemIndex) => {
    const loadOptions: any = {
      requireTotalCount: false,
      requireGroupCount: true,
      group: [currentGroup],
      groupSummary: options.storeLoadOptions.groupSummary,
      filter: createGroupFilter(
        expandedInfo.paths[expandedItemIndex],
        {
          filter: options.storeLoadOptions.filter,
          group: groups,
        },
        columnsController
      ),
      select: options.storeLoadOptions.select,
      langParams: options.storeLoadOptions?.langParams,
    };

    if (expandedItemIndex === 0) {
      loadOptions.skip = expandedInfo.skip || 0;
    }

    if (expandedItemIndex === expandedInfo.paths.length - 1) {
      loadOptions.take = expandedInfo.take;
    }

    const loadResult =
      loadOptions.take === 0 ? [] : that._dataSource.loadFromStore(loadOptions);

    when(loadResult).done((data) => {
      const item = expandedInfo.items[expandedItemIndex];
      const path = expandedInfo.paths[expandedItemIndex];

      applyContinuationToGroupItem(
        options,
        expandedInfo,
        groupLevel,
        expandedItemIndex
      );

      // 注意：子分组项的 key 字段是分组值，用于创建过滤器查询服务器数据
      // 不能修改子分组项的 key，否则会导致查询失败
      // 只有在 loadLastLevelGroupItems 中加载的最终数据行才需要修改 key 以确保唯一性
      console.log(
        `[loadExpandedGroups] 处理嵌套分组数据，路径:`,
        path,
        `数据项数量:`,
        data ? (Array.isArray(data) ? data.length : "not array") : "null"
      );

      // 子分组数据直接使用，不修改 key（因为 key 是分组值，必须保持原样）
      item.items = data;
    });

    deferreds.push(loadResult);
  });

  when.apply(null, deferreds).done(() => {
    updateGroupInfos(that, options, data, loadedGroupCount + 1);

    loadGroupItems(
      that,
      options,
      loadedGroupCount + 1,
      expandedInfo,
      groupLevel + 1,
      data
    );
  });
}

function loadLastLevelGroupItems(that, options, expandedInfo, data) {
  const expandedFilters: any[] = [];
  const groups = options.group || [];

  // 获取 columnsController，用于判断多值字段
  const columnsController =
    that._dataSource?._dataController?._columnsController;

  each(expandedInfo.paths, (_, expandedPath) => {
    const groupFilter = createGroupFilter(
      expandedPath,
      {
        group: options.isCustomLoading
          ? options.storeLoadOptions.group
          : groups,
      },
      columnsController
    );

    expandedFilters.push(groupFilter);
  });

  let { filter } = options.storeLoadOptions;

  if (!options.storeLoadOptions.isLoadingAll) {
    const combinedExpandedFilters = dataGridCore.combineFilters(
      expandedFilters,
      "or"
    );

    filter = dataGridCore.combineFilters([filter, combinedExpandedFilters]);
  }

  const loadOptions = extend({}, options.storeLoadOptions, {
    requireTotalCount: false,
    requireGroupCount: false,
    group: null,
    sort: groups.concat(
      dataGridCore.normalizeSortingInfo(options.storeLoadOptions.sort || [])
    ),
    filter,
  });

  const isPagingLocal = that._dataSource.isLastLevelGroupItemsPagingLocal();

  if (!isPagingLocal) {
    loadOptions.skip = expandedInfo.skip;
    loadOptions.take = expandedInfo.take;
  }

  when(
    expandedInfo.take === 0 ? [] : that._dataSource.loadFromStore(loadOptions)
  )
    .done((items) => {
      if (isPagingLocal) {
        items = that._dataSource.sortLastLevelGroupItems(
          items,
          groups,
          expandedInfo.paths
        );
        items = expandedInfo.skip ? items.slice(expandedInfo.skip) : items;
        items = expandedInfo.take ? items.slice(0, expandedInfo.take) : items;
      }

      const originalItemsLength = items ? items.length : 0;
      // 获取最后一个分组字段的 selector，用于匹配数据
      const lastGroup = groups[groups.length - 1];
      // 尝试多种方式获取 selector
      const groupSelector =
        lastGroup?.selector ||
        lastGroup?.dataField ||
        (lastGroup && typeof lastGroup === "string" ? lastGroup : null);

      // 尝试从 columnsController 获取分组列信息
      let groupColumn: any = null;
      try {
        const columnsController =
          that._dataSource?._dataController?._columnsController;
        if (columnsController) {
          const groupColumns = columnsController.getGroupColumns();
          if (groupColumns && groupColumns.length > 0) {
            groupColumn = groupColumns[groupColumns.length - 1];
          }
        }
      } catch (e) {
        console.log("[loadLastLevelGroupItems] 无法获取 columnsController:", e);
      }

      // 输出第一条数据的结构，用于调试
      if (items && items.length > 0) {
        const firstItem = items[0];
        let firstItemGroupValue: any = null;
        if (
          groupColumn &&
          typeof groupColumn.calculateGroupValue === "function"
        ) {
          try {
            firstItemGroupValue = groupColumn.calculateGroupValue(firstItem);
          } catch (e) {
            console.log(
              "[loadLastLevelGroupItems] calculateGroupValue 执行失败:",
              e
            );
          }
        }
        if (!firstItemGroupValue && groupSelector) {
          firstItemGroupValue = firstItem[groupSelector];
        }
        if (!firstItemGroupValue && groupColumn?.dataField) {
          firstItemGroupValue = firstItem[groupColumn.dataField];
        }
      }

      // 如果服务器返回的数据少于预期，说明数据是共用的
      // 需要根据数据的实际分组值来匹配分组项，而不是按顺序分配
      const isDataShared =
        originalItemsLength <
        expandedInfo.items.reduce(
          (sum: number, item: any) => sum + (item.count || 0),
          0
        );

      if (isDataShared && groupSelector && items && items.length > 0) {
        // 数据共用情况：根据数据的实际分组值匹配分组项
        each(expandedInfo.items, (index, item) => {
          const path = expandedInfo.paths[index];
          const expectedGroupValue = path[path.length - 1]; // 最后一个路径值就是分组值

          // 查找匹配该分组值的数据
          const matchedItems: any[] = [];
          each(items, (itemIndex, dataItem) => {
            let actualGroupValue;

            // 优先使用 groupColumn 的 calculateGroupValue
            if (
              groupColumn &&
              typeof groupColumn.calculateGroupValue === "function"
            ) {
              try {
                actualGroupValue = groupColumn.calculateGroupValue(dataItem);
              } catch (e) {
                console.log(
                  `[loadLastLevelGroupItems] calculateGroupValue 执行失败 (item ${itemIndex}):`,
                  e
                );
              }
            }

            // 如果还没有获取到，尝试其他方式
            if (actualGroupValue === undefined || actualGroupValue === null) {
              if (typeof groupSelector === "function") {
                actualGroupValue = groupSelector(dataItem);
              } else if (typeof groupSelector === "string") {
                actualGroupValue = dataItem[groupSelector];
              } else if (groupColumn?.dataField) {
                actualGroupValue = dataItem[groupColumn.dataField];
              } else if (lastGroup?.dataField) {
                actualGroupValue = dataItem[lastGroup.dataField];
              } else {
                actualGroupValue = dataItem.key;
              }
            }

            // 处理分组值可能是逗号分隔的多值字符串的情况
            // 例如：actualGroupValue = '姜博耀,许南'，expectedGroupValue = '姜博耀'
            let isMatch = false;

            if (actualGroupValue !== undefined && actualGroupValue !== null) {
              // 如果 actualGroupValue 是字符串且包含逗号，说明可能是多值
              if (
                typeof actualGroupValue === "string" &&
                actualGroupValue.includes(",")
              ) {
                // 将字符串按逗号分割，去除空格，然后检查是否包含期望值
                const values = actualGroupValue.split(",").map((v) => v.trim());
                const comparableExpected = toComparable(
                  expectedGroupValue,
                  true
                );

                // 检查期望值是否在值列表中
                for (const value of values) {
                  if (toComparable(value, true) === comparableExpected) {
                    isMatch = true;
                    break;
                  }
                }
              } else {
                // 单值情况，直接比较
                const comparableActual = toComparable(actualGroupValue, true);
                const comparableExpected = toComparable(
                  expectedGroupValue,
                  true
                );
                isMatch = comparableActual === comparableExpected;
              }
            }

            // 如果匹配，添加到匹配列表
            if (isMatch) {
              matchedItems.push(dataItem);
            }
          });

          // 深拷贝匹配的数据，并为每个分组项的数据生成唯一的 key
          // 需要修改 DataGrid 实际使用的 keyExpr 以确保唯一性
          let keyExpr: string | null = null;
          try {
            // 优先从 dataController 获取 keyExpr
            const dataController = that._dataSource?._dataController;
            if (dataController) {
              const key = dataController.key();
              if (key && typeof key === "string") {
                keyExpr = key;
              }
            }

            // 如果无法从 dataController 获取，尝试从 DataGrid 的 option 中获取
            if (!keyExpr && that.option) {
              const optionKeyExpr = that.option("keyExpr");
              if (optionKeyExpr && typeof optionKeyExpr === "string") {
                keyExpr = optionKeyExpr;
              }
            }

            // 尝试从 DataSource 的 store 获取 key
            if (!keyExpr && that._dataSource?.store) {
              try {
                const storeKey = that._dataSource.store().key();
                if (storeKey && typeof storeKey === "string") {
                  keyExpr = storeKey;
                }
              } catch (e) {
                // 忽略错误
              }
            }
          } catch (e) {
            console.log("[loadLastLevelGroupItems] 无法获取 keyExpr:", e);
          }

          // 如果还是无法获取，尝试常见的 key 字段（包括 Id 和 Key）
          // 注意：从错误信息看，DataGrid 可能使用 Id 作为 keyExpr
          // 优先尝试 Id（因为错误信息显示的是数字 key），然后是 Key
          if (!keyExpr && matchedItems.length > 0) {
            const firstItem = matchedItems[0];
            // 尝试常见的 key 字段名（包括大小写变体）
            // 优先尝试 Id（因为错误信息显示的是数字），然后是 Key
            const possibleKeyNames = ["Id", "id", "ID", "Key", "key", "KEY"];

            for (const possibleKey of possibleKeyNames) {
              if (firstItem[possibleKey] !== undefined) {
                keyExpr = possibleKey;
                break;
              }
            }
          }

          const expandedItems = matchedItems.map((dataItem, itemIndex) => {
            const copiedItem = extend({}, dataItem);

            // 为 DataGrid 实际使用的 keyExpr 字段生成唯一的 key
            // 如果 keyExpr 是显示列（如 Id），保存原始值以便显示
            if (keyExpr) {
              const keyExprValue = keyExpr; // 保存到局部变量，确保类型检查通过
              if (copiedItem[keyExprValue] !== undefined) {
                const originalKey = copiedItem[keyExprValue];
                // 使用分组路径和索引生成唯一 key
                const uniqueKey = `${originalKey}_group_${path.join(
                  "_"
                )}_${index}_${itemIndex}`;

                // 保存原始值（如果 keyExpr 是 Id，保存到 _originalId）
                // 这样用户可以通过自定义列模板来显示原始值
                if (
                  keyExprValue === "Id" ||
                  keyExprValue === "id" ||
                  keyExprValue === "ID"
                ) {
                  copiedItem["_originalId"] = originalKey;
                } else if (
                  keyExprValue === "Key" ||
                  keyExprValue === "key" ||
                  keyExprValue === "KEY"
                ) {
                  copiedItem["_originalKey"] = originalKey;
                }

                // 修改 keyExpr 字段为唯一值
                copiedItem[keyExprValue] = uniqueKey;
              }
            } else if (keyExpr) {
              console.warn(
                `[loadLastLevelGroupItems] 警告：keyExpr 为 ${keyExpr}，但数据项中没有该字段`
              );
            } else {
              console.warn(
                `[loadLastLevelGroupItems] 警告：无法确定 keyExpr，无法生成唯一 key`
              );
            }

            return copiedItem;
          });

          applyContinuationToGroupItem(
            options,
            expandedInfo,
            groups.length - 1,
            index
          );

          const beforeAssign = item.items ? item.items.length : 0;
          const beforeAssignData = item.items
            ? JSON.stringify(
                item.items.map((i: any) => i.id || i.key || "unknown")
              ).substring(0, 100)
            : "null";

          // 保存原始 item 引用，用于后续检查
          const itemRef = item;
          const itemKey = item.key;

          item.items = expandedItems;
          const afterAssign = item.items ? item.items.length : 0;
          const afterAssignData = item.items
            ? JSON.stringify(
                item.items.map((i: any) => i.id || i.key || "unknown")
              ).substring(0, 100)
            : "null";

          // 延迟检查，看看数据是否被其他地方修改
          setTimeout(() => {
            const currentLength = item.items ? item.items.length : 0;
            const currentData = item.items
              ? JSON.stringify(
                  item.items.map((i: any) => i.id || i.key || "unknown")
                ).substring(0, 100)
              : "null";
            if (
              currentLength !== afterAssign ||
              currentData !== afterAssignData
            ) {
              console.warn(
                `[loadLastLevelGroupItems] ⚠️ 数据被修改了！分组项 ${index} (${itemKey}):`,
                {
                  path,
                  originalLength: afterAssign,
                  currentLength,
                  originalData: afterAssignData,
                  currentData,
                }
              );
            }
          }, 100);
        });
      } else {
        // 非共用数据情况：按顺序分配数据（原有逻辑）
        let currentIndex = 0;

        each(expandedInfo.items, (index, item) => {
          const itemCount =
            item.count - ((index === 0 && expandedInfo.skip) || 0);
          const path = expandedInfo.paths[index];

          // 使用 slice 获取数据片段，并深拷贝每个对象避免引用共享
          const expandedItems = items
            .slice(currentIndex, currentIndex + itemCount)
            .map((dataItem) => extend({}, dataItem));

          currentIndex += itemCount;

          applyContinuationToGroupItem(
            options,
            expandedInfo,
            groups.length - 1,
            index
          );

          const beforeAssign = item.items ? item.items.length : 0;
          const beforeAssignData = item.items
            ? JSON.stringify(
                item.items.map((i: any) => i.id || i.key || "unknown")
              ).substring(0, 100)
            : "null";

          const itemRef = item;
          const itemKey = item.key;

          item.items = expandedItems;
          const afterAssign = item.items ? item.items.length : 0;
          const afterAssignData = item.items
            ? JSON.stringify(
                item.items.map((i: any) => i.id || i.key || "unknown")
              ).substring(0, 100)
            : "null";

          // 延迟检查，看看数据是否被其他地方修改
          setTimeout(() => {
            const currentLength = item.items ? item.items.length : 0;
            const currentData = item.items
              ? JSON.stringify(
                  item.items.map((i: any) => i.id || i.key || "unknown")
                ).substring(0, 100)
              : "null";
            if (
              currentLength !== afterAssign ||
              currentData !== afterAssignData
            ) {
              console.warn(
                `[loadLastLevelGroupItems] ⚠️ 数据被修改了！分组项 ${index} (${itemKey}):`,
                {
                  path,
                  originalLength: afterAssign,
                  currentLength,
                  originalData: afterAssignData,
                  currentData,
                }
              );
            }
          }, 100);
        });
      }

      options.data.resolve(data);
    })
    .fail(options.data.reject);
}

const loadGroupTotalCount = function (dataSource, options) {
  // @ts-expect-error
  const d = new Deferred();
  const isGrouping = !!(options.group && options.group.length);
  const loadOptions = extend(
    {
      skip: 0,
      take: 1,
      requireGroupCount: isGrouping,
      requireTotalCount: !isGrouping,
    },
    options,
    { group: isGrouping ? options.group : null }
  );

  dataSource
    .load(loadOptions)
    .done((data, extra) => {
      const count = extra && (isGrouping ? extra.groupCount : extra.totalCount);

      if (!isFinite(count)) {
        d.reject(dataErrors.Error(isGrouping ? "E4022" : "E4021"));
        return;
      }
      d.resolve(count);
    })
    .fail(d.reject.bind(d));
  return d;
};

export class GroupingHelper extends GroupingHelperCore {
  public updateTotalItemsCount(options) {
    let totalItemsCount = 0;
    const totalCount = (options.extra && options.extra.totalCount) || 0;
    const groupCount = (options.extra && options.extra.groupCount) || 0;
    const pageSize = this._dataSource.pageSize();
    const isVirtualPaging = this._isVirtualPaging();

    foreachExpandedGroups(this, (groupInfo) => {
      groupInfo.childrenTotalCount = 0;
    });

    foreachExpandedGroups(this, (groupInfo, parents) => {
      const totalOffset = getTotalOffset(
        parents,
        isVirtualPaging ? 0 : pageSize,
        totalItemsCount
      );
      let count = groupInfo.count + groupInfo.childrenTotalCount;

      if (!isVirtualPaging) {
        count += getContinuationGroupCount(
          totalOffset,
          pageSize,
          count,
          parents.length - 1
        );
      }
      if (parents[parents.length - 2]) {
        parents[parents.length - 2].childrenTotalCount += count;
      } else {
        totalItemsCount += count;
      }
    });
    super.updateTotalItemsCount(totalItemsCount - totalCount + groupCount);
  }

  private _isGroupExpanded(groupIndex) {
    const groups = this._dataSource.group();
    return isGroupExpanded(groups, groupIndex);
  }

  private _updatePagingOptions(options, callback?) {
    const that = this;
    const isVirtualPaging = that._isVirtualPaging();
    const pageSize = that._dataSource.pageSize();
    const skips: any[] = [];
    const takes: any[] = [];
    let skipChildrenTotalCount = 0;
    let childrenTotalCount = 0;

    if (options.take) {
      foreachExpandedGroups(this, (groupInfo) => {
        groupInfo.childrenTotalCount = 0;
        groupInfo.skipChildrenTotalCount = 0;
      });
      foreachExpandedGroups(that, (groupInfo, parents) => {
        let take;
        let takeCorrection = 0;
        let parentTakeCorrection = 0;
        const totalOffset = getTotalOffset(
          parents,
          isVirtualPaging ? 0 : pageSize,
          childrenTotalCount
        );
        let continuationGroupCount = 0;
        let skipContinuationGroupCount = 0;
        let groupInfoCount = groupInfo.count + groupInfo.childrenTotalCount;
        let childrenGroupInfoCount = groupInfoCount;

        callback && callback(groupInfo, totalOffset);

        const skip = options.skip - totalOffset;
        if (totalOffset <= options.skip + options.take && groupInfoCount) {
          take = options.take;

          if (!isVirtualPaging) {
            continuationGroupCount = getContinuationGroupCount(
              totalOffset,
              pageSize,
              groupInfoCount,
              parents.length - 1
            );
            groupInfoCount += continuationGroupCount * parents.length;
            childrenGroupInfoCount += continuationGroupCount;
            if (pageSize && skip >= 0) {
              takeCorrection = parents.length;
              parentTakeCorrection = parents.length - 1;
              skipContinuationGroupCount = Math.floor(skip / pageSize);
            }
          }

          if (skip >= 0) {
            if (totalOffset + groupInfoCount > options.skip) {
              skips.unshift(
                skip -
                  skipContinuationGroupCount * takeCorrection -
                  groupInfo.skipChildrenTotalCount
              );
            }
            if (totalOffset + groupInfoCount >= options.skip + take) {
              takes.unshift(
                take -
                  takeCorrection -
                  groupInfo.childrenTotalCount +
                  groupInfo.skipChildrenTotalCount
              );
            }
          } else if (totalOffset + groupInfoCount >= options.skip + take) {
            takes.unshift(take + skip - groupInfo.childrenTotalCount);
          }
        }

        if (totalOffset <= options.skip) {
          if (parents[parents.length - 2]) {
            parents[parents.length - 2].skipChildrenTotalCount += Math.min(
              childrenGroupInfoCount,
              skip + 1 - skipContinuationGroupCount * parentTakeCorrection
            );
          } else {
            skipChildrenTotalCount += Math.min(
              childrenGroupInfoCount,
              skip + 1
            );
          }
        }
        if (totalOffset <= options.skip + take) {
          groupInfoCount = Math.min(
            childrenGroupInfoCount,
            skip +
              take -
              (skipContinuationGroupCount + 1) * parentTakeCorrection
          );
          if (parents[parents.length - 2]) {
            parents[parents.length - 2].childrenTotalCount += groupInfoCount;
          } else {
            childrenTotalCount += groupInfoCount;
          }
        }
      });
      options.skip -= skipChildrenTotalCount;
      options.take -= childrenTotalCount - skipChildrenTotalCount;
    }

    options.skips = skips;
    options.takes = takes;
  }

  private changeRowExpand(path) {
    const that = this;
    const groupInfo = that.findGroupInfo(path);
    const dataSource = that._dataSource;
    const remoteGroupPaging = dataSource.remoteOperations().groupPaging;
    const groups = dataGridCore.normalizeSortingInfo(dataSource.group());
    // 获取 columnsController，用于判断多值字段
    const columnsController = dataSource?._dataController?._columnsController;

    if (groupInfo) {
      groupInfo.isExpanded = !groupInfo.isExpanded;

      if (
        remoteGroupPaging &&
        groupInfo.isExpanded &&
        path.length < groups.length
      ) {
        return loadGroupTotalCount(dataSource, {
          filter: createGroupFilter(
            path,
            {
              filter: dataSource.lastLoadOptions().filter,
              group: dataSource.group(),
            },
            columnsController
          ),
          group: [groups[path.length]],
          select: dataSource.select(),
        }).done((groupCount) => {
          groupInfo.count = groupCount;
        });
      }
      // @ts-expect-error
      return new Deferred().resolve();
    }
    // @ts-expect-error
    return new Deferred().reject();
  }

  protected handleDataLoading(options?) {
    const that = this;
    const { storeLoadOptions } = options;
    const groups = dataGridCore.normalizeSortingInfo(
      storeLoadOptions.group || options.loadOptions.group
    );

    if (options.isCustomLoading || !groups.length) {
      return;
    }

    if (options.remoteOperations.grouping) {
      const remotePaging = that._dataSource.remoteOperations().paging;

      storeLoadOptions.group = dataGridCore.normalizeSortingInfo(
        storeLoadOptions.group
      );
      storeLoadOptions.group.forEach((group, index) => {
        const isLastGroup = index === storeLoadOptions.group.length - 1;
        group.isExpanded = !remotePaging || !isLastGroup;
      });
    }

    options.group = options.group || groups;

    if (options.remoteOperations.paging) {
      options.skip = storeLoadOptions.skip;
      options.take = storeLoadOptions.take;
      storeLoadOptions.requireGroupCount = true;
      storeLoadOptions.group = groups.slice(0, 1);
      that._updatePagingOptions(options);

      storeLoadOptions.skip = options.skip;
      storeLoadOptions.take = options.take;
    } else {
      options.skip = options.loadOptions.skip;
      options.take = options.loadOptions.take;
      that._updatePagingOptions(options);
    }
  }

  protected handleDataLoadedCore(options, callBase) {
    const that = this;
    const loadedGroupCount = dataGridCore.normalizeSortingInfo(
      options.storeLoadOptions.group || options.loadOptions.group
    ).length;
    const groupCount = options.group ? options.group.length : 0;
    let totalCount;
    const expandedInfo = {};

    if (options.isCustomLoading) {
      callBase(options);

      processGroupItems(
        that,
        options.data,
        loadedGroupCount,
        expandedInfo,
        [],
        options.isCustomLoading,
        options.storeLoadOptions.isLoadingAll
      );
    } else {
      if (!options.remoteOperations.paging) {
        that.foreachGroups((groupInfo) => {
          groupInfo.count = 0;
        });
      }

      totalCount = updateGroupInfos(
        that,
        options,
        options.data,
        loadedGroupCount
      );

      if (totalCount < 0) {
        // @ts-expect-error
        options.data = new Deferred().reject(errors.Error("E1037"));
        return;
      }

      if (!options.remoteOperations.paging) {
        if (
          loadedGroupCount &&
          options.extra &&
          options.loadOptions.requireTotalCount
        ) {
          options.extra.totalCount = totalCount;
          options.extra.groupCount = options.data.length;
        }
      }

      if (
        groupCount &&
        options.storeLoadOptions.requireGroupCount &&
        !isFinite(options.extra.groupCount)
      ) {
        // @ts-expect-error
        options.data = new Deferred().reject(dataErrors.Error("E4022"));
        return;
      }

      that.updateTotalItemsCount(options);

      if (!options.remoteOperations.paging) {
        that._updatePagingOptions(options);
        options.lastLoadOptions.skips = options.skips;
        options.lastLoadOptions.takes = options.takes;
      }
      callBase(options);

      if (!options.remoteOperations.paging) {
        that._processPaging(options, loadedGroupCount);
      }
    }

    loadGroupItems(
      that,
      options,
      loadedGroupCount,
      expandedInfo,
      0,
      options.data
    );
  }

  private _processSkips(items, skips, groupCount) {
    if (!groupCount) return;

    const firstItem = items[0];
    const skip = skips[0];
    const children = firstItem && firstItem.items;

    if (skip !== undefined) {
      firstItem.isContinuation = true;

      if (children) {
        firstItem.items = children.slice(skip);
        this._processSkips(firstItem.items, skips.slice(1), groupCount - 1);
      }
    }
  }

  private _processTakes(items, skips, takes, groupCount, parents?) {
    if (!groupCount || !items) return;

    parents = parents || [];

    const lastItem = items[items.length - 1];
    let children = lastItem && lastItem.items;
    const take = takes[0];
    const skip = skips[0];

    if (lastItem) {
      const maxTakeCount =
        lastItem.count - ((lastItem.isContinuation && skip) || 0) ||
        children.length;

      if (take !== undefined && maxTakeCount > take) {
        lastItem.isContinuationOnNextPage = true;
        parents.forEach((parent) => {
          parent.isContinuationOnNextPage = true;
        });
        if (children) {
          children = children.slice(0, take);
          lastItem.items = children;
        }
      }
      parents.push(lastItem);
      this._processTakes(
        children,
        skips.slice(1),
        takes.slice(1),
        groupCount - 1,
        parents
      );
    }
  }

  private _processPaging(options, groupCount) {
    this._processSkips(options.data, options.skips, groupCount);
    this._processTakes(options.data, options.skips, options.takes, groupCount);
  }

  private isLastLevelGroupItemsPagingLocal() {
    return false;
  }

  private sortLastLevelGroupItems(items) {
    return items;
  }

  protected refresh(options, operationTypes?) {
    const that = this;
    const dataSource = that._dataSource;
    const { storeLoadOptions } = options;
    const group = options.group || options.storeLoadOptions.group;
    const oldGroups = dataGridCore.normalizeSortingInfo(that._group);
    let isExpanded;
    let groupIndex;

    function handleGroup(groupInfo, parents) {
      if (parents.length === groupIndex + 1) {
        groupInfo.isExpanded = isExpanded;
      }
    }

    for (groupIndex = 0; groupIndex < oldGroups.length; groupIndex++) {
      isExpanded = isGroupExpanded(group, groupIndex);
      if (isGroupExpanded(that._group, groupIndex) !== isExpanded) {
        that.foreachGroups(handleGroup);
      }
    }

    // @ts-expect-error
    super.refresh.apply(this, arguments);

    if (group && options.remoteOperations.paging && operationTypes.reload) {
      // 获取 columnsController，用于判断多值字段
      const columnsController = dataSource?._dataController?._columnsController;

      return foreachExpandedGroups(
        that,
        (groupInfo) => {
          const groupCountQuery = loadGroupTotalCount(dataSource, {
            filter: createGroupFilter(
              groupInfo.path,
              {
                filter: storeLoadOptions.filter,
                group,
              },
              columnsController
            ),
            group: group.slice(groupInfo.path.length),
            select: storeLoadOptions.select,
          });
          const groupOffsetQuery = loadGroupTotalCount(dataSource, {
            filter: createOffsetFilter(
              groupInfo.path,
              {
                filter: storeLoadOptions.filter,
                group,
              },
              true
            ),
            group: group.slice(
              groupInfo.path.length - 1,
              groupInfo.path.length
            ),
            select: storeLoadOptions.select,
          });

          return when(groupOffsetQuery, groupCountQuery).done(
            (offset, count) => {
              // eslint-disable-next-line radix
              offset = parseInt(offset.length ? offset[0] : offset);
              // eslint-disable-next-line radix
              count = parseInt(count.length ? count[0] : count);
              groupInfo.offset = offset;
              if (groupInfo.count !== count) {
                groupInfo.count = count;
                that.updateTotalItemsCount(options);
              }
            }
          );
        },
        true
      );
    }
  }
}

/// #DEBUG
export { getContinuationGroupCount };
/// #ENDDEBUG
