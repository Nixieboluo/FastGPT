import React, { useMemo } from 'react';
import { type NodeProps, Position, useViewport } from 'reactflow';
import { Box } from '@chakra-ui/react';
import NodeCard from './render/NodeCard';
import { type FlowNodeItemType } from '@fastgpt/global/core/workflow/type/node';
import Container from '../components/Container';
import RenderInput from './render/RenderInput';
import { NodeInputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import { useTranslation } from 'next-i18next';
import { type FlowNodeInputItemType } from '@fastgpt/global/core/workflow/type/io';
import { getNanoid } from '@fastgpt/global/common/string/tools';
import { MySourceHandle } from './render/Handle';
import { getHandleId } from '@fastgpt/global/core/workflow/utils';
import { type UserSelectOptionItemType } from '@fastgpt/global/core/workflow/template/system/interactive/type';
import IOTitle from '../components/IOTitle';
import RenderOutput from './render/RenderOutput';
import DraggableInputList from '@/components/core/app/DraggableInputList';
import { getOutputDisconnectCommands } from '@/web/core/workflow/utils';
import { useField, useNode, useWorkflow } from '@/web/core/workflow/editor';

const NodeUserSelect = ({ data, selected }: NodeProps<FlowNodeItemType>) => {
  const { t } = useTranslation();
  const { nodeId, inputs, outputs } = data;
  const node = useNode(nodeId);
  const { edges } = useWorkflow();
  // CustomComponent 是被 RenderInput 直接调用的普通函数，字段句柄必须在组件顶层取。
  const optionsField = useField(nodeId, NodeInputKeyEnum.userSelectOptions, 'input');
  const { zoom } = useViewport();

  const CustomComponent = useMemo(
    () => ({
      [NodeInputKeyEnum.userSelectOptions]: (v: FlowNodeInputItemType) => {
        const { key: optionKey, value } = v;
        const options = value as UserSelectOptionItemType[];

        return (
          <Box>
            <DraggableInputList<UserSelectOptionItemType>
              items={options}
              zoom={zoom}
              addText={t('common:core.module.Add_option')}
              onDragEnd={(list) => {
                optionsField?.setValue(list);
              }}
              onChange={(key, value) => {
                const newVal = options.map((val) =>
                  val.key === key
                    ? {
                        ...val,
                        value
                      }
                    : val
                );
                optionsField?.setValue(newVal);
              }}
              onAdd={() => {
                optionsField?.setValue(options.concat({ value: '', key: getNanoid() }));
              }}
              onDelete={(key) => {
                // 删除选项要同时断开该分支 handle 上的连线：同一事务提交，撤销只需一步。
                const documentInputs = node?.data.inputs;
                if (!documentInputs) return;
                node?.updateNode(
                  {
                    inputs: documentInputs.map((input) =>
                      input.key === optionKey
                        ? { ...input, value: options.filter((option) => option.key !== key) }
                        : input
                    )
                  },
                  {
                    disconnectEdges: getOutputDisconnectCommands({ edges, nodeId, outputKey: key })
                  }
                );
              }}
              renderRight={(item, snapshot) =>
                !snapshot.isDragging && (
                  <MySourceHandle
                    nodeId={nodeId}
                    handleId={getHandleId(nodeId, 'source', item.key)}
                    position={Position.Right}
                    // Handler 渲染在 DraggableInputList 的 flex 输入容器内；右侧删除按钮和 gap
                    // 使该容器比节点内容区域缩进 24px，需要补偿后才能与节点右边缘对齐。
                    translate={[58, 0]}
                  />
                )
              }
            />
          </Box>
        );
      }
    }),
    [edges, node, nodeId, optionsField, t, zoom]
  );

  return (
    <NodeCard minW={'400px'} selected={selected} {...data}>
      <Container>
        <RenderInput nodeId={nodeId} flowInputList={inputs} CustomComponent={CustomComponent} />
      </Container>
      <Container>
        <IOTitle text={t('common:Output')} />
        <RenderOutput nodeId={nodeId} flowOutputList={outputs} />
      </Container>
    </NodeCard>
  );
};
export default React.memo(NodeUserSelect);
