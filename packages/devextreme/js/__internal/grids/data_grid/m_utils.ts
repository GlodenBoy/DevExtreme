import { normalizeSortingInfo } from "@js/common/data/utils";
import gridCoreUtils from "@ts/grids/grid_core/m_utils";

export function createGroupFilter(
  path,
  storeLoadOptions,
  columnsController?: any
) {
  const groups = normalizeSortingInfo(storeLoadOptions.group);

  const filter: any = [];

  for (let i = 0; i < path.length; i++) {
    const group = groups[i];
    const selector = group.selector;
    const pathValue = path[i];

    // 检查是否需要使用多值字段匹配（用于逗号分隔的字符串）
    let isMultiValueField = false;

    // 尝试从 columnsController 获取列配置
    if (columnsController) {
      try {
        const groupColumns = columnsController.getGroupColumns();
        if (groupColumns && groupColumns[i]) {
          const column = groupColumns[i];
          const dataField = column.dataField || selector;

          // 对于可能包含多值的字段（如 currentAssignees），使用多值匹配
          if (dataField && typeof dataField === "string") {
            // 检查字段名是否包含可能的多值字段标识
            const multiValueFields = [
              "Assignees",
              "Participants",
              "Followers",
              "Tags",
              "Members",
            ];
            isMultiValueField = multiValueFields.some((field) =>
              dataField.includes(field)
            );
          }
        }
      } catch (e) {
        // 忽略错误
      }
    }

    // 如果没有 columnsController，根据字段名判断
    if (!isMultiValueField && selector && typeof selector === "string") {
      const multiValueFields = [
        "Assignees",
        "Participants",
        "Followers",
        "Tags",
        "Members",
      ];
      isMultiValueField = multiValueFields.some((field) =>
        selector.includes(field)
      );
    }

    // 对于多值字段，使用多个条件来精确匹配（避免匹配到 '张三丰' 当搜索 '张三' 时）
    // 参考服务器端 C# 代码，只需要 4 个条件：
    // 1. field = 'value' (完全匹配)
    // 2. field LIKE 'value,%' (值在开头，后面有逗号)
    // 3. field LIKE '%,value,%' (值在中间，前后都有逗号)
    // 4. field LIKE '%,value' (值在结尾，前面有逗号)
    if (isMultiValueField && pathValue && typeof pathValue === "string") {
      // 生成 4 个条件来精确匹配逗号分隔的值，与服务器端 C# 代码保持一致：
      const multiValueFilter: any[] = [
        [selector, "=", pathValue], // 1. 完全匹配 -> field = 'value'
        "or",
        [selector, "startswith", pathValue + ","], // 2. 值在开头，后面有逗号 -> LIKE 'value,%'
        "or",
        [selector, "endswith", "," + pathValue], // 4. 值在结尾，前面有逗号 -> LIKE '%,value'
        "or",
        [selector, "contains", "," + pathValue + ","], // 3. 值在中间，前后都有逗号 -> LIKE '%,value,%'
      ];

      console.log(`[createGroupFilter] 多值字段过滤器 (${selector}):`, {
        pathValue,
        multiValueFilter,
        note: "生成 4 个条件，与服务器端 C# 代码保持一致",
      });

      filter.push(multiValueFilter);
    } else {
      // 单值字段，使用 = 操作符
      filter.push([selector, "=", pathValue]);
    }
  }

  if (storeLoadOptions.filter) {
    filter.push(storeLoadOptions.filter);
  }
  return gridCoreUtils.combineFilters(filter);
}
