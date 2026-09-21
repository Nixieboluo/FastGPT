import React, { useCallback, useMemo } from 'react';
import NodeCard from '../render/NodeCard';
import { useTranslation } from 'next-i18next';
import { Box, Button, Flex } from '@chakra-ui/react';
import { NodeInputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import { type NodeProps, Position } from 'reactflow';
import { type FlowNodeItemType } from '@fastgpt/global/core/workflow/type/node';
import { type IfElseListItemType } from '@fastgpt/global/core/workflow/template/system/ifElse/type';
import {
  createIfElseBranchId,
  getIfElseBranchHandleKey
} from '@fastgpt/global/core/workflow/template/system/ifElse/utils';
import Container from '../../components/Container';
import DndDrag, { Draggable } from '@fastgpt/web/components/common/DndDrag/index';
import { MySourceHandle } from '../render/Handle';
import { getHandleId } from '@fastgpt/global/core/workflow/utils';
import ListItem from './ListItem';
import { IfElseResultEnum } from '@fastgpt/global/core/workflow/template/system/ifElse/constant';
import MyIcon from '@fastgpt/web/components/common/Icon';
import { getOutputDisconnectCommands } from '@/web/core/workflow/utils';
import { useField, useNode, useWorkflow } from '@/web/core/workflow/editor';

const NodeIfElse = ({ data, selected }: NodeProps<FlowNodeItemType>) => {
  const { t } = useTranslation();
  const { nodeId, inputs = [] } = data;
  const node = useNode(nodeId);
  const { edges } = useWorkflow();
  const ifElseListField = useField(nodeId, NodeInputKeyEnum.ifElseList, 'input');
  const elseHandleId = getHandleId(nodeId, 'source', IfElseResultEnum.ELSE);

  const ifElseList = useMemo(
    () =>
      (inputs.find((input) => input.key === NodeInputKeyEnum.ifElseList)
        ?.value as IfElseListItemType[]) || [],
    [inputs]
  );

  /** 分支列表整体就是 ifElseList 字段的值：增删改都按完整数组提交，一次交互一条历史。 */
  const onUpdateIfElseList = useCallback(
    (value: IfElseListItemType[]) => {
      ifElseListField?.setValue(value);
    },
    [ifElseListField]
  );

  /**
   * 删除分支：分支 handle 上的连线必须和分支记录在同一事务里消失，
   * 否则撤销要按两下才能还原一次删除。
   */
  const onDeleteBranch = useCallback(
    (conditionIndex: number) => {
      const documentInputs = node?.data.inputs;
      const branch = ifElseList[conditionIndex];
      if (!documentInputs || !branch) return;

      node?.updateNode(
        {
          inputs: documentInputs.map((input) =>
            input.key === NodeInputKeyEnum.ifElseList
              ? { ...input, value: ifElseList.filter((_, index) => index !== conditionIndex) }
              : input
          )
        },
        {
          disconnectEdges: getOutputDisconnectCommands({
            edges,
            nodeId,
            outputKey: getIfElseBranchHandleKey(branch)
          })
        }
      );
    },
    [edges, ifElseList, node, nodeId]
  );

  return (
    <NodeCard selected={selected} maxW={'1000px'} {...data}>
      <Flex flexDirection={'column'} cursor={'default'}>
        <DndDrag<IfElseListItemType>
          onDragEndCb={(list: IfElseListItemType[]) => onUpdateIfElseList(list)}
          dataList={ifElseList}
          renderClone={(provided, snapshot, rubric) => (
            <ListItem
              provided={provided}
              snapshot={snapshot}
              conditionItem={ifElseList[rubric.source.index]}
              conditionIndex={rubric.source.index}
              ifElseList={ifElseList}
              onUpdateIfElseList={onUpdateIfElseList}
              onDeleteBranch={onDeleteBranch}
              nodeId={nodeId}
            />
          )}
        >
          {({ provided }) => (
            <Box {...provided.droppableProps} ref={provided.innerRef}>
              {ifElseList.map((conditionItem, conditionIndex) => (
                <Draggable
                  key={getIfElseBranchHandleKey(conditionItem)}
                  draggableId={getIfElseBranchHandleKey(conditionItem)}
                  index={conditionIndex}
                >
                  {(provided, snapshot) => (
                    <ListItem
                      provided={provided}
                      snapshot={snapshot}
                      conditionItem={conditionItem}
                      conditionIndex={conditionIndex}
                      ifElseList={ifElseList}
                      onUpdateIfElseList={onUpdateIfElseList}
                      onDeleteBranch={onDeleteBranch}
                      nodeId={nodeId}
                    />
                  )}
                </Draggable>
              ))}
            </Box>
          )}
        </DndDrag>

        <Container position={'relative'}>
          <Flex alignItems={'center'}>
            <Box color={'black'} fontSize={'md'} ml={2}>
              {IfElseResultEnum.ELSE}
            </Box>
            <MySourceHandle
              nodeId={nodeId}
              handleId={elseHandleId}
              position={Position.Right}
              translate={[18, 0]}
            />
          </Flex>
        </Container>
      </Flex>
      <Box py={3} px={4}>
        <Button
          variant={'whiteBase'}
          w={'full'}
          leftIcon={<MyIcon name={'common/addLight'} boxSize={4} mr={-1} />}
          onClick={() => {
            onUpdateIfElseList([
              ...ifElseList,
              {
                branchId: createIfElseBranchId(),
                condition: 'AND',
                list: [
                  {
                    variable: undefined,
                    condition: undefined,
                    value: undefined,
                    valueType: 'input'
                  }
                ]
              }
            ]);
          }}
        >
          {t('common:core.module.input.Add Branch')}
        </Button>
      </Box>
    </NodeCard>
  );
};
export default React.memo(NodeIfElse);
