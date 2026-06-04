use std::collections::{HashMap, HashSet};
use std::ops::Range;

use gerber_types::ApertureBlock;
use gerber_types::{
    Aperture, ApertureDefinition, ApertureMacro, Command, Coordinates, DCode, ExtendedCode,
    FunctionCode, GCode, InterpolationMode, MacroDecimal, Operation, QuadrantMode, StepAndRepeat,
};
use log::{debug, error, info, trace, warn};
use nalgebra::{Point2, Vector2};

use self::aperture::{flash_standard_aperture, process_content, ApertureKind};
use self::plot::plot_circular_interpolation;
use self::region::Region;
use super::bbox::WithBoundingBox;
use super::primitive::{
    ArcGerberPrimitive, CircleGerberPrimitive, GerberPrimitive, LineGerberPrimitive,
    PolygonGerberPrimitive, RectangleGerberPrimitive,
};
use super::GerberLayer;
use crate::viewer::expressions::{evaluate_expression, MacroContext};
use crate::viewer::geometry::BoundingBox;
use crate::viewer::spacial::ToVector;
use crate::viewer::types::Exposure;

mod aperture;
mod plot;
mod region;
#[cfg(test)]
mod tests;

impl GerberLayer {
    fn update_position(
        current_pos: &mut Point2<f64>,
        coords: &Option<Coordinates>,
        offset: Vector2<f64>,
    ) {
        let Some(coords) = coords else { return };

        let (x, y) = (
            coords
                .x
                .map(|value| value.into())
                .map(|value: f64| value + offset.x)
                .unwrap_or(current_pos.x),
            coords
                .y
                .map(|value| value.into())
                .map(|value: f64| value + offset.y)
                .unwrap_or(current_pos.y),
        );

        *current_pos = Point2::new(x, y);
    }

    pub(crate) fn calculate_bounding_box(primitives: &Vec<GerberPrimitive>) -> BoundingBox {
        let mut bbox = BoundingBox::default();

        for primitive in primitives {
            let primitive_bbox = match primitive {
                GerberPrimitive::Circle(primitive) => primitive.bounding_box(),
                GerberPrimitive::Arc(primitive) => primitive.bounding_box(),
                GerberPrimitive::Rectangle(primitive) => primitive.bounding_box(),
                GerberPrimitive::Line(primitive) => primitive.bounding_box(),
                GerberPrimitive::Polygon(primitive) => primitive.bounding_box(),
            };
            bbox.expand(&primitive_bbox);
        }

        trace!("layer bbox: {:?}", bbox);

        bbox
    }

    pub(super) fn build_primitives(commands: &[Command]) -> Vec<GerberPrimitive> {
        #[derive(Debug)]
        struct StepRepeatState {
            initial_position: Point2<f64>,
            start_index: usize,

            repeat_x: u32,
            repeat_y: u32,
            distance_x: f64,
            distance_y: f64,

            x_index: u32,
            y_index: u32,
        }

        let mut macro_definitions: HashMap<String, &ApertureMacro> = HashMap::default();

        // First pass: collect aperture macros
        for cmd in commands.iter() {
            if let Command::ExtendedCode(ExtendedCode::ApertureMacro(macro_def)) = cmd {
                macro_definitions.insert(macro_def.name.clone(), macro_def);
            }
        }

        // Second pass - collect aperture definitions, build their primitives (using supplied args)

        #[derive(Debug, Clone)]
        struct BlockAperture {
            code: i32,
            range: Range<usize>,
        }

        #[derive(Debug)]
        enum LocalApertureKind {
            Standard(ApertureKind),
            Block(BlockAperture),
        }

        let mut apertures: HashMap<i32, LocalApertureKind> = HashMap::default();

        // entries are pushed onto the stack as AB 'open' commands are found
        // popped off the stack and stored in the aperture definitions when a corresponding AB 'close' command is encountered.

        let mut aperture_block_discovery_stack: Vec<ApertureBlockDiscovery> = Vec::new();
        #[derive(Debug, Clone)]
        struct ApertureBlockDiscovery {
            code: i32,
            start: usize,
            // the end is unknown until the corresponding AB 'close' command is encountered
        }

        for (index, command) in commands.iter().enumerate() {
            match command {
                Command::ExtendedCode(ExtendedCode::ApertureBlock(ApertureBlock::Open {
                    code,
                })) => {
                    let discovery = ApertureBlockDiscovery {
                        code: *code,
                        start: index,
                    };
                    trace!(
                        "aperture block discovery started. discovery: {:?}",
                        discovery
                    );

                    aperture_block_discovery_stack.push(discovery);
                }
                Command::ExtendedCode(ExtendedCode::ApertureBlock(ApertureBlock::Close)) => {
                    if let Some(discovery) = aperture_block_discovery_stack.last_mut() {
                        let block = BlockAperture {
                            code: discovery.code,
                            // +1 and -1 to exclude the AB 'open/close' commands themselves
                            range: Range {
                                start: discovery.start + 1,
                                end: index - 1,
                            },
                        };
                        trace!("aperture block discovery completed. block: {:?}", block);
                        apertures.insert(discovery.code, LocalApertureKind::Block(block));
                        aperture_block_discovery_stack.pop();
                    } else {
                        error!("Aperture block close without matching open");
                    }
                }
                Command::ExtendedCode(ExtendedCode::ApertureDefinition(ApertureDefinition {
                    code,
                    aperture,
                })) => match aperture {
                    Aperture::Macro(macro_name, args) => {
                        // Handle macro-based apertures

                        if let Some(macro_def) = macro_definitions.get(macro_name) {
                            //
                            // build a unique name based on the macro name and args
                            //
                            let macro_name_and_args = match args {
                                None => macro_name,
                                Some(args) => {
                                    let args_str = args
                                        .iter()
                                        .map(|arg| {
                                            let meh = match arg {
                                                MacroDecimal::Value(value) => value.to_string(),
                                                MacroDecimal::Variable(variable) => {
                                                    format!("${}", variable)
                                                }
                                                MacroDecimal::Expression(expression) => {
                                                    expression.clone()
                                                }
                                            };

                                            meh
                                        })
                                        .collect::<Vec<_>>()
                                        .join("X");

                                    &format!("{}_{}", macro_name, args_str)
                                }
                            };
                            debug!("macro_name_and_args: {}", macro_name_and_args);

                            let mut macro_context = MacroContext::default();

                            //
                            // populate the macro_context from the args.
                            //
                            if let Some(args) = args {
                                for (index, arg) in args.iter().enumerate() {
                                    let arg_number = (index + 1) as u32;

                                    match arg {
                                        MacroDecimal::Value(value) => {
                                            macro_context
                                                .put(arg_number, *value)
                                                .inspect_err(|error| {
                                                    error!(
                                                        "Error setting variable {}: {}",
                                                        arg_number, error
                                                    );
                                                })
                                                .ok();
                                        }
                                        MacroDecimal::Variable(variable) => {
                                            macro_context
                                                .put(arg_number, macro_context.get(variable))
                                                .inspect_err(|error| {
                                                    error!(
                                                        "Error setting variable {}: {}",
                                                        arg_number, error
                                                    );
                                                })
                                                .ok();
                                        }
                                        MacroDecimal::Expression(expression) => {
                                            evaluate_expression(expression, &macro_context)
                                                .map(|value| {
                                                    macro_context
                                                        .put(arg_number, value)
                                                        .inspect_err(|error| {
                                                            error!(
                                                                "Error setting variable {}: {}",
                                                                arg_number, error
                                                            );
                                                        })
                                                        .ok();
                                                })
                                                .inspect_err(|error| {
                                                    error!(
                                                        "Error evaluating expression {}: {}",
                                                        expression, error
                                                    );
                                                })
                                                .ok();
                                        }
                                    }
                                }
                            }

                            trace!("initial macro_context: {:?}", macro_context);

                            let mut primitive_defs = vec![];

                            for content in &macro_def.content {
                                trace!("macro_content: {:?}", content);

                                let result = process_content(content, &mut macro_context);
                                match result {
                                    Err(cause) => {
                                        error!(
                                            "Error processing macro content: {:?}, cause: {}",
                                            content, cause
                                        );
                                    }
                                    Ok(Some(primitive)) => primitive_defs.push(primitive),
                                    Ok(None) => {}
                                }
                            }
                            trace!("final macro_context: {:?}", macro_context);

                            trace!("primitive_defs: {:?}", primitive_defs);

                            apertures.insert(
                                *code,
                                LocalApertureKind::Standard(ApertureKind::Macro(primitive_defs)),
                            );
                        } else {
                            error!(
                                "Aperture definition references unknown macro. macro_name: {}",
                                macro_name
                            );
                        }
                    }
                    _ => {
                        apertures.insert(
                            *code,
                            LocalApertureKind::Standard(ApertureKind::Standard(aperture.clone())),
                        );
                    }
                },
                _ => {}
            }
        }
        info!("macros: {:?}", macro_definitions.len());

        debug!("aperture codes: {:?}", apertures.keys());
        info!("apertures: {:?}", apertures.len());

        // Third pass: collect all primitives, handle regions, aperture-block replay and step-repeat blocks

        let mut layer_primitives = Vec::new();
        let mut current_pos = Point2::new(0.0, 0.0);

        let mut current_aperture = None;
        let mut interpolation_mode = InterpolationMode::Linear;
        let mut quadrant_mode = QuadrantMode::Single;

        // also record aperture selection errors
        let mut aperture_selection_errors: HashSet<i32> = HashSet::new();

        // regions are a special case - they are defined by aperture codes
        let mut current_region = None;

        let mut index = 0;

        // set to some when the first step-repeat block is encountered
        let mut step_repeat_state: Option<StepRepeatState> = None;
        // not using an option here to keep the math simple
        let mut step_repeat_offset: Vector2<f64> = Vector2::new(0.0, 0.0);

        #[derive(Debug, Clone)]
        struct ApertureBlockReplayState<'a> {
            block: &'a BlockAperture,
            initial_position: Point2<f64>,
            initial_index: usize,
            initial_offset: Vector2<f64>,
            initial_interpolation_mode: InterpolationMode,
            initial_quadrant_mode: QuadrantMode,
        }

        let mut aperture_block_replay_stack: Vec<ApertureBlockReplayState> = vec![];
        let mut aperture_block_offset: Vector2<f64> = Vector2::new(0.0, 0.0);

        loop {
            trace!(
                "aperture_block_replay_stack: {:?}",
                aperture_block_replay_stack
            );
            if let Some(state) = aperture_block_replay_stack.last_mut() {
                if index > state.block.range.end {
                    trace!("completed aperture block replay");

                    // The gerber spec says: "After an AB statemen[t] the graphics state remains as it is at the end of
                    // the AB definition, except for the current point, which is undefined. (Gerber has no stack of
                    // graphics states.)"
                    // but let's be consistent by resetting the position to the position when the block we started.
                    // We could just not do this, which might be more 'compliant', but inconsistent.

                    current_pos = state.initial_position;
                    interpolation_mode = state.initial_interpolation_mode;
                    quadrant_mode = state.initial_quadrant_mode;

                    // furthermore, the statement in the spec "Gerber has no stack of graphics states" is misleading,
                    // since we have to reset the current aperture and restore the offset, both of which require
                    // a 'stack of graphic states'.
                    aperture_block_offset = state.initial_offset;
                    // restore the current aperture to this one, since it may be re-used by the next flash command
                    // before another Dxx code is encountered.
                    current_aperture = apertures.get(&state.block.code);

                    // skip the same command, otherwise we'd repeat forever
                    index = state.initial_index + 1;
                    aperture_block_replay_stack.pop();

                    // in the case of nested blocks, we need to check again to see if we're ending the outer block, so
                    // we `continue` here.
                    continue;
                }
            }

            trace!(
                "index: {}, current_position: {}, step_repeat_offset: ({},{}), aperture_block_offset: ({},{})",
                index,
                current_pos,
                step_repeat_offset.x,
                step_repeat_offset.y,
                aperture_block_offset.x,
                aperture_block_offset.y
            );
            let Some(cmd) = commands.get(index) else {
                break;
            };

            match cmd {
                Command::ExtendedCode(ExtendedCode::ApertureBlock(ApertureBlock::Open {
                    code,
                })) => {
                    // We can get here on an outer block in the case of nested blocked
                    if !aperture_block_replay_stack.is_empty() {
                        trace!("AB (open) during replay");
                    } else {
                        // we're waiting for a block aperture to be selected
                    }

                    // we already discovered the block, get the corresponding block then
                    // jump the the command after it.
                    let block = apertures.get(code).unwrap();
                    if let LocalApertureKind::Block(block) = block {
                        // +1 for the AB close itself, +1 again so we start on the command after it.
                        index = block.range.end + 2;
                        trace!("AB (open), skipping to: {:?}", index);
                        continue;
                    } else {
                        error!("AB (open) not using an aperture block definition");
                    }
                }
                Command::ExtendedCode(ExtendedCode::ApertureBlock(ApertureBlock::Close)) => {
                    // this shouldn't happen, since the block range should cause this to be skipped
                    // when the AP (open) is processed
                    error!("AB (close) encountered during 3rd pass");

                    if !aperture_block_replay_stack.is_empty() {
                        trace!("AB (close) during replay");
                    } else {
                        // we're waiting for a block aperture to be selected
                    }
                    unreachable!()
                }
                Command::ExtendedCode(ExtendedCode::StepAndRepeat(StepAndRepeat::Open {
                    repeat_x,
                    repeat_y,
                    distance_x,
                    distance_y,
                })) => {
                    if !aperture_block_replay_stack.is_empty() {
                        trace!("SR (open) during AB replay");
                    } else {
                        if step_repeat_state.is_some() {
                            error!("Step repeat open without matching close");
                        } else {
                            let state = StepRepeatState {
                                initial_position: current_pos,
                                repeat_x: *repeat_x,
                                repeat_y: *repeat_y,
                                distance_x: *distance_x,
                                distance_y: *distance_y,
                                start_index: index + 1,
                                x_index: 0,
                                y_index: 0,
                            };
                            trace!("Step-and-repeat open, state: {:?}", state);
                            step_repeat_state = Some(state);
                        }
                    }
                }
                Command::ExtendedCode(ExtendedCode::StepAndRepeat(StepAndRepeat::Close)) => {
                    if !aperture_block_replay_stack.is_empty() {
                        trace!("SR (close) during AB replay");
                    } else {
                        if let Some(state) = &mut step_repeat_state {
                            let mut complete = false;
                            state.y_index += 1;
                            if state.y_index >= state.repeat_y {
                                state.y_index = 0;

                                state.x_index += 1;
                                if state.x_index >= state.repeat_x {
                                    complete = true;
                                }
                            }

                            // The gerber spec says "The current point is undefined after an SR statement."
                            // but let's be consistent by resetting the position to the position when the
                            // block we started, for commands AFTER the step-repeat and for commands
                            // in the next step-repeat iteration.
                            // We could just not do this, which might be more 'compliant', but inconsistent.
                            current_pos = state.initial_position;

                            if complete {
                                trace!("Step-and-repeat close");
                                step_repeat_offset = Vector2::new(0.0, 0.0);
                                step_repeat_state = None;
                            } else {
                                step_repeat_offset = Vector2::new(
                                    state.distance_x * state.x_index as f64,
                                    state.distance_y * state.y_index as f64,
                                );

                                trace!(
                                    "Step-and-repeat continue, state: {:?}, current_position: {:?}",
                                    state,
                                    current_pos
                                );

                                index = state.start_index;
                                continue;
                            }
                        } else {
                            error!("Step repeat close without matching open");
                        }
                    }
                }
                Command::FunctionCode(FunctionCode::GCode(GCode::InterpolationMode(mode))) => {
                    interpolation_mode = *mode;
                }
                Command::FunctionCode(FunctionCode::GCode(GCode::QuadrantMode(mode))) => {
                    quadrant_mode = *mode;
                }
                Command::FunctionCode(FunctionCode::GCode(GCode::RegionMode(enabled))) => {
                    if *enabled {
                        // G36 - Begin Region
                        current_region = Some(Region::new(index));
                    } else {
                        // G37 - End Region
                        if let Some(region) = current_region.take() {
                            if let Ok(primitive) = region.finalize(index) {
                                layer_primitives.push(primitive);
                            }
                        }
                    }
                }

                Command::FunctionCode(FunctionCode::DCode(DCode::SelectAperture(code))) => {
                    current_aperture = apertures.get(code);
                    if current_aperture.is_none() {
                        aperture_selection_errors.insert(*code);
                    }
                }
                Command::FunctionCode(FunctionCode::DCode(DCode::Operation(operation))) => {
                    match operation {
                        Operation::Move(coords) => {
                            let mut end = current_pos;
                            Self::update_position(
                                &mut end,
                                coords,
                                step_repeat_offset + aperture_block_offset,
                            );
                            if current_region.is_some() {
                                // In a region, a move operation starts a new path segment
                                // However, we may not have any segments yet, i.e. G36 immediately followed by D02
                                let mut region = current_region.take().unwrap();

                                if !region.is_empty() {
                                    if let Ok(primitive) = region.finalize(index) {
                                        layer_primitives.push(primitive);
                                    }

                                    region = Region::new(index);
                                }
                                region.push(end);

                                current_region = Some(region);
                            }
                            current_pos = end;
                        }
                        Operation::Interpolate(coords, offset) => {
                            let mut end = current_pos;
                            Self::update_position(
                                &mut end,
                                coords,
                                step_repeat_offset + aperture_block_offset,
                            );
                            if let Some(region) = &mut current_region {
                                // Add vertex to the current region
                                region.push(end);
                            } else {
                                match current_aperture {
                                    // 2024.05 - 2.3 "Graphical objects"
                                    // "The solid circle standard aperture is the only aperture allowed for creating draw or arc objects.
                                    // Other standard apertures or macro apertures that fortuitously have a circular shape are not
                                    // allowed."
                                    Some(LocalApertureKind::Standard(ApertureKind::Standard(
                                        Aperture::Circle(circle),
                                    ))) => {
                                        // get the stroke width with the aperture definition
                                        let stroke_width = circle.diameter;

                                        match interpolation_mode {
                                            InterpolationMode::Linear => {
                                                layer_primitives.push(GerberPrimitive::Line(
                                                    LineGerberPrimitive {
                                                        start: current_pos,
                                                        end,
                                                        width: stroke_width,
                                                        exposure: Exposure::Add,
                                                    },
                                                ));
                                            }
                                            InterpolationMode::ClockwiseCircular
                                            | InterpolationMode::CounterclockwiseCircular => {
                                                // Handle circular interpolation
                                                if let Some(offset) = offset {
                                                    plot_circular_interpolation(
                                                        current_pos,
                                                        end,
                                                        offset,
                                                        stroke_width,
                                                        interpolation_mode,
                                                        quadrant_mode,
                                                        &mut layer_primitives,
                                                    );
                                                }
                                            }
                                        }
                                    }
                                    Some(aperture) => {
                                        warn!(
                                            "Unsupported aperture for plotting. aperture: {:?}",
                                            aperture
                                        );
                                    }
                                    None => {
                                        error!("No aperture selected for plotting");
                                    }
                                }
                            }
                            current_pos = end;
                        }
                        Operation::Flash(coords, ..) => {
                            if current_region.is_some() {
                                warn!("Flash operation found within region - ignoring");
                            } else {
                                Self::update_position(
                                    &mut current_pos,
                                    coords,
                                    step_repeat_offset + aperture_block_offset,
                                );

                                if let Some(aperture) = current_aperture {
                                    match aperture {
                                        LocalApertureKind::Standard(ApertureKind::Macro(
                                            macro_primitives,
                                        )) => {
                                            for primitive in macro_primitives {
                                                let mut primitive = primitive.clone();
                                                // Update the primitive's position based on flash coordinates
                                                match &mut primitive {
                                                    GerberPrimitive::Polygon(
                                                        PolygonGerberPrimitive { center, .. },
                                                    ) => {
                                                        *center += Vector2::new(
                                                            current_pos.x,
                                                            current_pos.y,
                                                        );
                                                    }
                                                    GerberPrimitive::Circle(
                                                        CircleGerberPrimitive { center, .. },
                                                    ) => {
                                                        *center += Vector2::new(
                                                            current_pos.x,
                                                            current_pos.y,
                                                        );
                                                    }
                                                    GerberPrimitive::Arc(ArcGerberPrimitive {
                                                        center,
                                                        ..
                                                    }) => {
                                                        *center += Vector2::new(
                                                            current_pos.x,
                                                            current_pos.y,
                                                        );
                                                    }
                                                    GerberPrimitive::Rectangle(
                                                        RectangleGerberPrimitive { origin, .. },
                                                    ) => {
                                                        *origin += Vector2::new(
                                                            current_pos.x,
                                                            current_pos.y,
                                                        );
                                                    }
                                                    GerberPrimitive::Line(
                                                        LineGerberPrimitive { start, end, .. },
                                                    ) => {
                                                        *start += Vector2::new(
                                                            current_pos.x,
                                                            current_pos.y,
                                                        );
                                                        *end += Vector2::new(
                                                            current_pos.x,
                                                            current_pos.y,
                                                        );
                                                    }
                                                }
                                                trace!("flashing macro primitive: {:?}", primitive);
                                                layer_primitives.push(primitive);
                                            }
                                        }
                                        LocalApertureKind::Standard(ApertureKind::Standard(
                                            aperture,
                                        )) => {
                                            flash_standard_aperture(
                                                aperture,
                                                current_pos,
                                                &mut layer_primitives,
                                            );
                                        }
                                        LocalApertureKind::Block(block) => {
                                            trace!("flashing block aperture: {:?}", block);

                                            let state = ApertureBlockReplayState {
                                                block,
                                                initial_position: current_pos,
                                                initial_index: index,
                                                initial_offset: aperture_block_offset,
                                                initial_interpolation_mode: interpolation_mode,
                                                initial_quadrant_mode: quadrant_mode,
                                            };
                                            aperture_block_replay_stack.push(state);

                                            aperture_block_offset = current_pos.to_vector();
                                            index = block.range.start;
                                            continue;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                _ => {}
            }

            index += 1;
        }

        if !aperture_selection_errors.is_empty() {
            error!(
                "Selecting some apertures failed; Check gerber file content and parser errors. aperture_codes: {:?}",
                aperture_selection_errors
            );
        }

        info!("layer_primitives: {:?}", layer_primitives.len());
        trace!("layer_primitives: {:?}", layer_primitives);

        layer_primitives
    }
}
