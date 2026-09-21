import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { RenderInputProps } from '../type';
import { Flex, Box, type ButtonProps, Grid } from '@chakra-ui/react';
import MyIcon from '@fastgpt/web/components/common/Icon';
import {
  filterSelectableWorkflowNodeOutputs,
  getNodeAllSource,
  getWorkflowGraphReader,
  type WorkflowGraphReader
} from '@/web/core/workflow/utils';
import { useSafeTranslation } from '@fastgpt/web/hooks/useSafeTranslation';
import { WorkflowIOValueTypeEnum } from '@fastgpt/global/core/workflow/constants';
import type {
  ReferenceArrayValueType,
  ReferenceItemValueType,
  ReferenceValueType
} from '@fastgpt/global/core/workflow/type/io';
import type { WorkflowFieldSnapshot } from '@fastgpt/global/core/workflow/editor/types';
import type { TFunction } from 'next-i18next';
import dynamic from 'next/dynamic';
import { isNestedParentNodeType } from '@fastgpt/global/core/workflow/node/constant';
import { useField, useNode } from '@/web/core/workflow/editor';
import { useWorkflowDocument, useWorkflowSnapshotGetter } from '../../useWorkflowDocument';

const MultipleRowSelect = dynamic(() =>
  import('@fastgpt/web/components/common/MySelect/MultipleRowSelect').then(
    (v) => v.MultipleRowSelect
  )
);
const MultipleRowArraySelect = dynamic(() =>
  import('@fastgpt/web/components/common/MySelect/MultipleRowSelect').then(
    (v) => v.MultipleRowArraySelect
  )
);
const Avatar = dynamic(() => import('@fastgpt/web/components/common/Avatar'));

export type ReferenceListItem = {
  label: string | React.ReactNode;
  value: string;
  name?: string;
  avatar?: string;
  children: {
    label: string;
    value: string;
    valueType?: WorkflowIOValueTypeEnum;
  }[];
};

type CommonSelectProps = {
  placeholder?: string;
  list: ReferenceListItem[];
  popDirection?: 'top' | 'bottom';
  ButtonProps?: ButtonProps;
  /** 懒加载列表：打开选择器时计算一次。此时已选内容必须同时给 reference，否则打开前无法解析。 */
  onOpenList?: () => void;
  /** 当前字段的引用状态；给出后已选内容按状态里的来源/输出名展示，不再依赖 list。 */
  reference?: WorkflowFieldSnapshot['references'];
};
type SelectProps<T extends boolean> = CommonSelectProps & {
  isArray?: T;
  value?: T extends true ? ReferenceArrayValueType : ReferenceItemValueType;
  onSelect: (val?: T extends true ? ReferenceArrayValueType : ReferenceItemValueType) => void;
};

/**
 * 计算某节点当前可引用的来源列表：普通模块纯函数，只读文档图查询面。
 * 不进 Context、不建订阅，由调用方决定何时计算（常驻派生列表或打开选择器时一次性计算）。
 */
export const getReferenceList = ({
  reader,
  nodeId,
  valueType = WorkflowIOValueTypeEnum.any,
  includeChildren,
  t
}: {
  reader: WorkflowGraphReader;
  nodeId: string;
  valueType?: WorkflowIOValueTypeEnum;
  /** 容器节点（loopRun）需要引用自身子工作流的输出时传 true。 */
  includeChildren?: boolean;
  t: TFunction;
}): ReferenceListItem[] => {
  const sourceNodes = getNodeAllSource({
    nodeId,
    getNodeById: reader.getNodeById,
    edges: reader.edges,
    chatConfig: reader.chatConfig,
    t,
    includeChildren,
    childrenNodeIdListMap: reader.childrenNodeIdListMap
  });

  const isArray = valueType?.includes('array');

  // 转换为 select 的数据结构
  return sourceNodes
    .map((node) => ({
      label: (
        <Flex alignItems={'center'}>
          <Avatar src={node.avatar} w={isArray ? '1rem' : '1.05rem'} borderRadius={'xs'} />
          <Box ml={1}>{node.name}</Box>
        </Flex>
      ),
      value: node.nodeId,
      name: node.name,
      avatar: node.avatar,
      children: filterSelectableWorkflowNodeOutputs({
        outputs: node.outputs,
        valueType,
        catchError: node.catchError
      }).map((output) => ({
        label: t(output.label as any),
        value: output.id,
        valueType: output.valueType
      }))
    }))
    .filter((item) => item.children.length > 0);
};

/**
 * 常驻的可用引用列表：随文档变化重算（host runtimeTick 驱动），不订阅数据 Context。
 * 已选内容按 list 解析展示，因此列表必须常驻；只在打开时计算的场景用 useLazyReferenceList。
 */
export const useReference = ({
  nodeId,
  valueType = WorkflowIOValueTypeEnum.any,
  includeChildren
}: {
  nodeId: string;
  valueType?: WorkflowIOValueTypeEnum;
  includeChildren?: boolean;
}) => {
  const { t } = useSafeTranslation();
  const { reader } = useWorkflowDocument();

  const referenceList = useMemo(
    () => (reader ? getReferenceList({ reader, nodeId, valueType, includeChildren, t }) : []),
    [reader, nodeId, valueType, includeChildren, t]
  );

  return { referenceList };
};

/**
 * 懒加载的可用引用列表：打开选择器时从最新文档快照计算一次，不建订阅、不进 Context。
 * 已选内容的展示由字段引用状态（useField().reference）提供，因此关闭期间列表可以保持为空。
 */
export const useLazyReferenceList = ({
  nodeId,
  valueType = WorkflowIOValueTypeEnum.any,
  includeChildren
}: {
  nodeId: string;
  valueType?: WorkflowIOValueTypeEnum;
  includeChildren?: boolean;
}) => {
  const { t } = useSafeTranslation();
  const getWorkflow = useWorkflowSnapshotGetter();
  const [referenceList, setReferenceList] = useState<ReferenceListItem[]>([]);

  const loadReferenceList = useCallback(() => {
    const workflow = getWorkflow();
    if (!workflow) return;
    setReferenceList(
      getReferenceList({
        reader: getWorkflowGraphReader(workflow),
        nodeId,
        valueType,
        includeChildren,
        t
      })
    );
  }, [getWorkflow, includeChildren, nodeId, t, valueType]);

  return { referenceList, loadReferenceList };
};

/**
 * 引用选择输入模板：写入只提交字段值（updateField），来源与已选内容都从字段句柄读，
 * 因此编辑只刷新当前字段订阅，不触发全图重算。
 */
const Reference = ({ item, nodeId }: RenderInputProps) => {
  const { t } = useSafeTranslation();
  const node = useNode(nodeId);
  const field = useField(nodeId, item.key, 'input');
  const { referenceList, loadReferenceList } = useLazyReferenceList({
    nodeId,
    valueType: item.valueType
  });

  const isArray = item.valueType?.includes('array') ?? false;

  const onSelect = useCallback(
    (e?: ReferenceValueType) => {
      field?.setValue(e);
    },
    [field]
  );

  const flowNodeType = node?.data.flowNodeType;
  // 嵌套容器节点（loop/parallelRun/loopRun）里的下拉向上展开，避免被子节点覆盖。
  const popDirection = useMemo(
    () => (flowNodeType && isNestedParentNodeType(flowNodeType) ? 'top' : 'bottom'),
    [flowNodeType]
  );

  return (
    <ReferSelector
      placeholder={t(item.referencePlaceholder as any) || t('common:select_reference_variable')}
      list={referenceList}
      value={item.value}
      onSelect={onSelect}
      popDirection={popDirection}
      isArray={isArray}
      onOpenList={loadReferenceList}
      reference={field?.reference}
    />
  );
};

export default React.memo(Reference);

const SingleReferenceSelector = ({
  placeholder,
  value,
  list = [],
  onSelect,
  popDirection,
  ButtonProps,
  onOpenList,
  reference
}: SelectProps<false>) => {
  // runtime 只发 i18n key 或字面量，展示名统一在渲染层过一遍 t。
  const { t } = useSafeTranslation();
  const getSelectValue = useCallback(
    (value: ReferenceValueType) => {
      if (!value) return undefined;

      // 给出字段引用状态时按状态展示：只有仍可选（valid）的引用显示名称，
      // 失效或类型不匹配的引用与旧行为一致地回落到占位符。
      if (reference) {
        const status = reference[0];
        if (status?.code !== 'valid') return undefined;
        const nodeText = status.sourceLabel ? t(status.sourceLabel) : '';
        const outputText = status.outputLabel ? t(status.outputLabel) : '';
        return {
          avatar: status.icon,
          text: nodeText && outputText ? `${nodeText} > ${outputText}` : nodeText || outputText
        };
      }

      const firstColumn = list.find((item) => item.value === value[0]);
      if (!firstColumn) {
        return undefined;
      }
      const secondColumn = firstColumn.children.find((item) => item.value === value[1]);
      if (!secondColumn) {
        return undefined;
      }
      const nodeText = firstColumn.name || '';
      const outputText = secondColumn.label || '';
      return {
        avatar: firstColumn.avatar,
        text: nodeText && outputText ? `${nodeText} > ${outputText}` : nodeText || outputText
      };
    },
    [list, reference, t]
  );

  // Adapt array type from old version
  useEffect(() => {
    if (
      Array.isArray(value) &&
      // @ts-ignore
      value.length === 1 &&
      Array.isArray(value[0]) &&
      value[0].length === 2
    ) {
      // @ts-ignore
      onSelect(value[0]);
    }
  }, [value, onSelect]);

  const ItemSelector = useMemo(() => {
    const selectorVal = value as ReferenceItemValueType;
    const selected = getSelectValue(selectorVal);

    return (
      <MultipleRowSelect
        label={
          selected ? (
            <Flex
              alignItems={'center'}
              minW={0}
              w={'100%'}
              overflow={'hidden'}
              fontSize={'sm'}
              data-preserve-width
            >
              {!!selected.avatar && (
                <Avatar src={selected.avatar} w={'1.05rem'} borderRadius={'xs'} flexShrink={0} />
              )}
              <Box
                data-preserve-width
                ml={selected.avatar ? 1 : 0}
                minW={0}
                flex={1}
                overflow={'hidden'}
                textOverflow={'ellipsis'}
                whiteSpace={'nowrap'}
              >
                {selected.text}
              </Box>
            </Flex>
          ) : (
            <Box fontSize={'sm'} color={'myGray.400'}>
              {placeholder}
            </Box>
          )
        }
        value={selectorVal}
        list={list}
        onSelect={onSelect as any}
        popDirection={popDirection}
        ButtonProps={ButtonProps}
        onOpenFunc={onOpenList}
      />
    );
  }, [ButtonProps, getSelectValue, list, onOpenList, onSelect, placeholder, popDirection, value]);

  return ItemSelector;
};
const MultipleReferenceSelector = ({
  placeholder,
  value,
  list = [],
  onSelect,
  popDirection,
  onOpenList,
  reference
}: SelectProps<true>) => {
  const { t } = useSafeTranslation();
  const getSelectValue = useCallback(
    (value: ReferenceValueType) => {
      if (!value) return [];

      const firstColumn = list.find((item) => item.value === value[0]);
      if (!firstColumn) {
        return [];
      }
      const secondColumn = firstColumn.children.find((item) => item.value === value[1]);
      if (!secondColumn) {
        return [];
      }
      return [firstColumn.label, secondColumn.label];
    },
    [list]
  );

  // Get valid item and remove invalid item
  const formatList = useMemo(() => {
    // 给出字段引用状态时按状态解析展示名，此时 list 可以是懒加载的空数组。
    if (reference) {
      return reference.map((status) => {
        const isValid = status.code === 'valid';
        return {
          rawValue: status.reference,
          nodeName: isValid && status.sourceLabel ? t(status.sourceLabel) : '',
          outputName: isValid && status.outputLabel ? t(status.outputLabel) : ''
        };
      });
    }

    if (!value || !Array.isArray(value)) return [];

    return value.map((item) => {
      const [nodeName, outputName] = getSelectValue(item);
      return {
        rawValue: item,
        nodeName,
        outputName
      };
    });
  }, [getSelectValue, reference, t, value]);

  const invalidList = useMemo(() => {
    return formatList.filter((item) => item.nodeName && item.outputName);
  }, [formatList]);

  useEffect(() => {
    // Adapt array type from old version
    if (Array.isArray(value) && typeof value[0] === 'string') {
      // @ts-ignore
      onSelect([value]);
    }
  }, [formatList, onSelect, value]);

  const ArraySelector = useMemo(() => {
    return (
      <MultipleRowArraySelect
        label={
          invalidList.length > 0 ? (
            <Grid
              py={3}
              gridTemplateColumns={'1fr 1fr'}
              gap={2}
              fontSize={'sm'}
              _hover={{
                '.delete': {
                  visibility: 'visible'
                }
              }}
            >
              {invalidList.map(({ nodeName, outputName }, index) => {
                return (
                  <Flex
                    key={index}
                    w={'100%'}
                    alignItems={'center'}
                    bg={'primary.50'}
                    color={'myGray.900'}
                    py={1}
                    px={1.5}
                    rounded={'sm'}
                  >
                    <Flex alignItems={'center'} flex={'1 0 0'} className="textEllipsis">
                      {nodeName}
                      <MyIcon
                        name={'common/rightArrowLight'}
                        mx={1}
                        w={'12px'}
                        color={'myGray.500'}
                      />
                      {outputName}
                    </Flex>
                    <MyIcon
                      className="delete"
                      visibility={'hidden'}
                      name={'common/closeLight'}
                      w={'1rem'}
                      ml={1}
                      cursor={'pointer'}
                      color={'myGray.500'}
                      _hover={{
                        color: 'red.600'
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(value?.filter((_, i) => i !== index));
                      }}
                    />
                  </Flex>
                );
              })}
            </Grid>
          ) : (
            <Box fontSize={'sm'} color={'myGray.400'}>
              {placeholder}
            </Box>
          )
        }
        value={value as any}
        list={list}
        onSelect={(e) => {
          onSelect(e as any);
        }}
        popDirection={popDirection}
        onOpenFunc={onOpenList}
      />
    );
  }, [invalidList, list, onOpenList, onSelect, placeholder, popDirection, value]);

  return ArraySelector;
};
export const ReferSelector = <T extends boolean>(props: SelectProps<T>) => {
  return props.isArray ? (
    <MultipleReferenceSelector {...(props as SelectProps<true>)} />
  ) : (
    <SingleReferenceSelector {...(props as SelectProps<false>)} />
  );
};
