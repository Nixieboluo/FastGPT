import React, { useMemo } from 'react';
import { type NodeProps, Position } from 'reactflow';
import { Box, Button, Flex, Textarea } from '@chakra-ui/react';
import NodeCard from './render/NodeCard';
import { type FlowNodeItemType } from '@fastgpt/global/core/workflow/type/node';
import Container from '../components/Container';
import RenderInput from './render/RenderInput';
import type { ClassifyQuestionAgentItemType } from '@fastgpt/global/core/workflow/template/system/classifyQuestion/type';
import MyIcon from '@fastgpt/web/components/common/Icon';
import { NodeInputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import { useTranslation } from 'next-i18next';
import MyTooltip from '@fastgpt/web/components/common/MyTooltip';
import { type FlowNodeInputItemType } from '@fastgpt/global/core/workflow/type/io';
import { getNanoid } from '@fastgpt/global/common/string/tools';
import { MySourceHandle } from './render/Handle';
import { getHandleId } from '@fastgpt/global/core/workflow/utils';
import { useMemoEnhance } from '@fastgpt/web/hooks/useMemoEnhance';
import { getOutputDisconnectCommands, splitToolInputsByMode } from '@/web/core/workflow/utils';
import { useIsToolNode } from './render/useWorkflowDocument';
import { useField, useNode, useWorkflow } from '@/web/core/workflow/editor';

const NodeCQNode = ({ data, selected }: NodeProps<FlowNodeItemType>) => {
  const { t } = useTranslation();
  const { nodeId, inputs } = data;
  const node = useNode(nodeId);
  const { edges } = useWorkflow();
  // CustomComponent 是被 RenderInput 直接调用的普通函数，字段句柄必须在组件顶层取。
  const agentsField = useField(nodeId, NodeInputKeyEnum.agents, 'input');
  const isTool = useIsToolNode(nodeId);
  const { commonInputs } = useMemoEnhance(
    () => splitToolInputsByMode(inputs, isTool),
    [inputs, isTool]
  );

  const CustomComponent = useMemo(
    () => ({
      [NodeInputKeyEnum.agents]: ({ key: agentKey, value = [] }: FlowNodeInputItemType) => {
        const agents = value as ClassifyQuestionAgentItemType[];
        return (
          <Box>
            {agents.map((item, i) => (
              <Box key={item.key} mb={4}>
                <Flex alignItems={'center'}>
                  <MyTooltip label={t('common:Delete')}>
                    <MyIcon
                      mt={1}
                      mr={2}
                      name={'circleMinus'}
                      w={'12px'}
                      cursor={'pointer'}
                      color={'myGray.600'}
                      _hover={{ color: 'red.600' }}
                      onClick={() => {
                        // 删除分类要同时断开该分支 handle 上的连线：同一事务提交，撤销只需一步。
                        const documentInputs = node?.data.inputs;
                        if (!documentInputs) return;
                        node?.updateNode(
                          {
                            inputs: documentInputs.map((input) =>
                              input.key === agentKey
                                ? {
                                    ...input,
                                    value: agents.filter((agent) => agent.key !== item.key)
                                  }
                                : input
                            )
                          },
                          {
                            disconnectEdges: getOutputDisconnectCommands({
                              edges,
                              nodeId,
                              outputKey: item.key
                            })
                          }
                        );
                      }}
                    />
                  </MyTooltip>
                  <Box flex={1} color={'myGray.600'} fontWeight={'medium'}>
                    {t('common:classification') + (i + 1)}
                  </Box>
                </Flex>
                <Box position={'relative'}>
                  <Textarea
                    rows={2}
                    mt={1}
                    defaultValue={item.value}
                    bg={'white'}
                    fontSize={'sm'}
                    onChange={(e) => {
                      const newVal = agents.map((val) =>
                        val.key === item.key
                          ? {
                              ...val,
                              value: e.target.value
                            }
                          : val
                      );
                      agentsField?.setValue(newVal);
                    }}
                  />
                  <MySourceHandle
                    nodeId={nodeId}
                    handleId={getHandleId(nodeId, 'source', item.key)}
                    position={Position.Right}
                    translate={[34, 0]}
                  />
                </Box>
              </Box>
            ))}
            <Button
              fontSize={'sm'}
              onClick={() => {
                const key = getNanoid();

                agentsField?.setValue(agents.concat({ value: '', key }));
              }}
            >
              {t('common:core.module.Add question type')}
            </Button>
          </Box>
        );
      }
    }),
    [agentsField, edges, node, nodeId, t]
  );

  const Render = useMemo(() => {
    return (
      <NodeCard minW={'400px'} selected={selected} {...data}>
        <Container>
          <RenderInput
            nodeId={nodeId}
            flowInputList={commonInputs}
            CustomComponent={CustomComponent}
            isTool={isTool}
          />
        </Container>
      </NodeCard>
    );
  }, [CustomComponent, commonInputs, data, isTool, nodeId, selected]);

  return Render;
};
export default React.memo(NodeCQNode);
