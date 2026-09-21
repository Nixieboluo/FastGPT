import { FixedTableContainer } from '@fastgpt/web/components/common/FixedTable';
import { type FlowNodeItemType } from '@fastgpt/global/core/workflow/type/node';
/* eslint-disable react-hooks/refs -- react-beautiful-dnd requires render-time drag props. */
import React, { useMemo, useState } from 'react';
import { type NodeProps, useViewport } from 'reactflow';
import NodeCard from '../render/NodeCard';
import Container from '../../components/Container';
import RenderInput from '../render/RenderInput';
import { NodeInputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import {
  type FlowNodeInputItemType,
  type FlowNodeOutputItemType
} from '@fastgpt/global/core/workflow/type/io';
import { Box, Button, Flex, HStack, Table, Tbody, Td, Th, Thead, Tr } from '@chakra-ui/react';
import { type UserInputFormItemType } from '@fastgpt/global/core/workflow/template/system/interactive/type';
import { useTranslation } from 'next-i18next';
import type { FlowNodeInputTypeEnum } from '@fastgpt/global/core/workflow/node/constant';
import {
  FlowNodeInputMap,
  FlowNodeOutputTypeEnum
} from '@fastgpt/global/core/workflow/node/constant';
import MyIcon from '@fastgpt/web/components/common/Icon';
import { SmallAddIcon } from '@chakra-ui/icons';
import IOTitle from '../../components/IOTitle';
import InputFormEditModal, { defaultFormInput } from './InputFormEditModal';
import RenderOutput from '../render/RenderOutput';
import FormLabel from '@fastgpt/web/components/common/MyBox/FormLabel';
import MyIconButton from '@fastgpt/web/components/common/Icon/button';
import DndDrag, {
  Draggable,
  type DraggableProvided,
  type DraggableStateSnapshot
} from '@fastgpt/web/components/common/DndDrag';
import { getOutputDisconnectCommands } from '@/web/core/workflow/utils';
import { useNode, useWorkflow } from '@/web/core/workflow/editor';

const NodeFormInput = ({ data, selected }: NodeProps<FlowNodeItemType>) => {
  const { nodeId, inputs, outputs } = data;
  const { t } = useTranslation();
  const node = useNode(nodeId);
  const { edges } = useWorkflow();
  const { zoom } = useViewport();

  const [editField, setEditField] = useState<UserInputFormItemType>();

  const CustomComponent = useMemo(
    () => ({
      [NodeInputKeyEnum.userInputForms]: ({ value, key }: FlowNodeInputItemType) => {
        const inputs = value as UserInputFormItemType[];

        /**
         * 提交表单字段编辑：字段列表与其结果 output 必须同一事务写入，否则撤销会拆成两步。
         * 新增走追加，编辑按原 key 定位；只有改名时旧 handle 上的连线才需要一起断开。
         */
        const onSubmit = (data: UserInputFormItemType) => {
          const documentInputs = node?.data.inputs;
          const documentOutputs = node?.data.outputs;
          if (!documentInputs || !documentOutputs) return;

          const editKey = editField?.key;
          const nextOutput: FlowNodeOutputItemType = editKey
            ? {
                // 编辑态必然能按原 key 找到 output；找不到时 map 不命中，等价于旧 replaceOutput 的空操作。
                ...(documentOutputs.find(
                  (output) => output.key === editKey
                ) as FlowNodeOutputItemType),
                valueType: data.valueType,
                key: data.key,
                label: data.label
              }
            : {
                id: data.key,
                valueType: data.valueType,
                key: data.key,
                label: data.label,
                type: FlowNodeOutputTypeEnum.static
              };

          node?.updateNode(
            {
              inputs: documentInputs.map((input) =>
                input.key === key
                  ? {
                      ...input,
                      value: editKey
                        ? inputs.map((item) => (item.key === editKey ? data : item))
                        : inputs.concat(data)
                    }
                  : input
              ),
              outputs: editKey
                ? documentOutputs.map((output) => (output.key === editKey ? nextOutput : output))
                : documentOutputs.concat(nextOutput)
            },
            editKey && editKey !== data.key
              ? {
                  disconnectEdges: getOutputDisconnectCommands({
                    edges,
                    nodeId,
                    outputKey: editKey
                  })
                }
              : undefined
          );
        };

        const onDelete = (valueKey: string) => {
          const documentInputs = node?.data.inputs;
          const documentOutputs = node?.data.outputs;
          if (!documentInputs || !documentOutputs) return;

          // 删除字段时其 output 与 handle 连线同事务消失，撤销一步恢复。
          node.updateNode(
            {
              inputs: documentInputs.map((input) =>
                input.key === key
                  ? { ...input, value: inputs.filter((item) => item.key !== valueKey) }
                  : input
              ),
              outputs: documentOutputs.filter((output) => output.key !== valueKey)
            },
            {
              disconnectEdges: getOutputDisconnectCommands({ edges, nodeId, outputKey: valueKey })
            }
          );
        };

        return (
          <Box>
            <HStack className="nodrag" cursor={'default'} mb={3}>
              <FormLabel fontSize={'sm'} color={'myGray.600'}>
                {t('workflow:user_form_input_config')}
              </FormLabel>
              <Box flex={'1 0 0'} />
              <Button
                variant={'grayGhost'}
                px={2}
                color={'myGray.600'}
                leftIcon={<SmallAddIcon />}
                iconSpacing={1}
                size={'sm'}
                onClick={() => {
                  setEditField(defaultFormInput);
                }}
              >
                {t('common:Add_new_input')}
              </Button>
              {!!editField && (
                <InputFormEditModal
                  defaultValue={editField}
                  keys={inputs.map((item) => item.key)}
                  onClose={() => {
                    setEditField(undefined);
                  }}
                  onSubmit={onSubmit}
                />
              )}
            </HStack>
            <FixedTableContainer
              bodyBg="white"
              flush
              className="nodrag nowheel"
              borderWidth={'1px'}
              borderRadius={'md'}
            >
              <Table variant={'workflow'}>
                <Thead>
                  <Tr>
                    <Th>{t('workflow:user_form_input_name')}</Th>
                    <Th>{t('workflow:user_form_input_description')}</Th>
                    <Th>{t('common:Required_input')}</Th>
                    <Th>{t('user:operations')}</Th>
                  </Tr>
                </Thead>
                <DndDrag<UserInputFormItemType>
                  onDragEndCb={(list) => {
                    const documentInputs = node?.data.inputs;
                    const documentOutputs = node?.data.outputs;
                    if (!documentInputs || !documentOutputs) return;

                    const sortedOutputs = [
                      documentOutputs[0],
                      ...documentOutputs.slice(1).sort((a, b) => {
                        const aIndex = list.findIndex((item) => item.key === a.key);
                        const bIndex = list.findIndex((item) => item.key === b.key);
                        return aIndex - bIndex;
                      })
                    ];

                    // 拖拽排序：字段顺序与 output 顺序同事务写入，撤销一步回到旧顺序。
                    node.updateNode({
                      inputs: documentInputs.map((input) =>
                        input.key === key ? { ...input, value: list } : input
                      ),
                      outputs: sortedOutputs
                    });
                  }}
                  dataList={inputs}
                  renderClone={(provided, snapshot, rubric) => {
                    const item = inputs[rubric.source.index];
                    const icon = FlowNodeInputMap[item.type as FlowNodeInputTypeEnum]?.icon;

                    return (
                      <TableItem
                        provided={provided}
                        snapshot={snapshot}
                        item={item}
                        icon={icon}
                        setEditField={setEditField}
                        onDelete={onDelete}
                      />
                    );
                  }}
                  zoom={zoom}
                >
                  {({ provided }) => (
                    <Tbody {...provided.droppableProps} ref={provided.innerRef}>
                      {inputs.map((item, index) => {
                        const icon = FlowNodeInputMap[item.type as FlowNodeInputTypeEnum]?.icon;
                        return (
                          <Draggable key={item.key} draggableId={item.key} index={index}>
                            {(provided, snapshot) => (
                              <TableItem
                                provided={provided}
                                snapshot={snapshot}
                                key={item.key}
                                item={item}
                                icon={icon}
                                setEditField={setEditField}
                                onDelete={onDelete}
                              />
                            )}
                          </Draggable>
                        );
                      })}
                    </Tbody>
                  )}
                </DndDrag>
              </Table>
            </FixedTableContainer>
          </Box>
        );
      }
    }),
    [t, editField, zoom, node, edges, nodeId]
  );

  return (
    <NodeCard minW={'400px'} selected={selected} {...data}>
      <Container>
        <IOTitle text={t('common:Input')} />
        <RenderInput nodeId={nodeId} flowInputList={inputs} CustomComponent={CustomComponent} />
      </Container>
      <Container>
        <IOTitle text={t('common:Output')} />
        <RenderOutput nodeId={nodeId} flowOutputList={outputs} />
      </Container>
    </NodeCard>
  );
};

export default React.memo(NodeFormInput);

const TableItem = ({
  provided,
  snapshot,
  item,
  icon,
  setEditField,
  onDelete
}: {
  provided: DraggableProvided;
  snapshot: DraggableStateSnapshot;
  item: UserInputFormItemType;
  icon: string;
  setEditField: (item: UserInputFormItemType) => void;
  onDelete: (valueKey: string) => void;
}) => {
  return (
    <Tr
      ref={provided.innerRef}
      {...provided.draggableProps}
      {...provided.dragHandleProps}
      style={{
        ...provided.draggableProps.style,
        opacity: snapshot.isDragging ? 0.8 : 1
      }}
    >
      <Td>
        <Flex alignItems={'center'} fontSize={'mini'} fontWeight={'medium'} whiteSpace={'nowrap'}>
          {!!icon && <MyIcon name={icon as any} w={'14px'} mr={1} color={'myGray.400'} />}
          {item.label}
        </Flex>
      </Td>
      <Td>{item.description || '-'}</Td>
      <Td>
        {item.required ? (
          <Flex alignItems={'center'}>
            <MyIcon name={'check'} w={'16px'} color={'myGray.900'} mr={2} />
          </Flex>
        ) : (
          '-'
        )}
      </Td>
      <Td>
        <Flex>
          <MyIconButton icon={'common/settingLight'} onClick={() => setEditField(item)} />
          <MyIconButton icon={'delete'} hoverColor={'red.500'} onClick={() => onDelete(item.key)} />
        </Flex>
      </Td>
    </Tr>
  );
};
